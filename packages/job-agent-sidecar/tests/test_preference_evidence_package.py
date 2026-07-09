from __future__ import annotations

import builtins
import json
from pathlib import Path
from typing import Any

from ggr_sidecar.application_preferences import (
    build_preference_clarification_answer,
    build_preference_evidence_package,
    build_preference_evidence_package_from_file,
    persist_preference_clarification_answer_to_file,
)
from ggr_sidecar.cli import main as cli_main


def test_build_preference_evidence_package_separates_tracks_and_counts_signals() -> None:
    package = build_preference_evidence_package(
        recent_applications_artifact=recent_applications_artifact(),
        now="2026-07-08T10:00:00.000Z",
    )

    assert package.schemaVersion == "preference-evidence-package.v1"
    assert package.cleanerVersion == "preference-evidence-cleaner.v1"
    assert package.source.kind == "recent_applications_with_jd"
    assert package.inputCoverage.recentApplicationsWithJd is True
    assert package.sampleCounts.totalRecords == 5
    assert package.sampleCounts.recordsWithJd == 5

    assert package.normalizedCounts.aiLlmAgent["present"] == 3
    assert package.normalizedCounts.backendData["present"] == 1
    assert package.normalizedCounts.annotationEvaluation["present"] == 2
    assert package.normalizedCounts.languageLocalization["present"] == 2
    assert package.normalizedCounts.remotePartTime["present"] == 2
    assert package.normalizedCounts.genericNonTarget["present"] == 1
    assert package.normalizedCounts.city["上海"] == 3
    assert package.normalizedCounts.city["远程"] == 2

    assert package.clusters.possibleMainTrack[0].id == "cluster-main-ai-backend"
    assert package.clusters.sideTrack[0].id == "cluster-side-ai-language-evaluation"
    assert package.clusters.sideTrackOnly[0].id == "cluster-side-only-localization-mtpe"
    assert package.clusters.downrank[0].id == "cluster-downrank-annotation-evaluation"
    assert package.clusters.exclude[0].id == "cluster-exclude-generic-non-target"


def test_representative_examples_have_deterministic_selection_reasons() -> None:
    package = build_preference_evidence_package(
        recent_applications_artifact=recent_applications_artifact(),
        now="2026-07-08T10:00:00.000Z",
    )

    reasons = {example.selectionReason for example in package.representativeExamples}
    assert {"strongest", "boundary", "contradiction"}.issubset(reasons)

    strongest = next(
        example
        for example in package.representativeExamples
        if example.selectionReason == "strongest"
        and example.clusterId == "cluster-main-ai-backend"
    )
    assert strongest.title == "AI Agent 后端开发"
    assert strongest.normalizedSignals == [
        "ai_llm_agent",
        "backend_data",
    ]
    assert strongest.evidenceRefs

    boundary = next(
        example
        for example in package.representativeExamples
        if example.selectionReason == "boundary"
    )
    assert boundary.title == "AIGC 数据评测实习生"
    assert "annotation_evaluation" in boundary.normalizedSignals

    contradiction = next(
        example
        for example in package.representativeExamples
        if example.selectionReason == "contradiction"
    )
    assert contradiction.title == "客服销售运营"
    assert contradiction.clusterId == "cluster-exclude-generic-non-target"

    indexed_ids = {entry.id for entry in package.evidenceIndex}
    for example in package.representativeExamples:
        assert set(example.evidenceRefs).issubset(indexed_ids)


def test_preference_evidence_package_redacts_sensitive_values_and_omits_raw_jd() -> None:
    raw_artifact = recent_applications_artifact()
    raw_artifact["records"].append(
        record(
            rank=6,
            conversation_id="conv-short-jd",
            title="Python 后端",
            company="Short JD Co",
            city="上海",
            position_category="后端开发",
            jd_text="负责 Python 后端开发",
        )
    )
    package = build_preference_evidence_package(
        recent_applications_artifact=raw_artifact,
        now="2026-07-08T10:00:00.000Z",
    )

    serialized = package.model_dump_json()

    for item in raw_artifact["records"]:
        assert item["jd"]["text"] not in serialized
    assert "CANARY_FULL_JOB_DESCRIPTION" not in serialized
    assert "CANARY_COOKIE_VALUE" not in serialized
    assert "CANARY_LOCAL_STORAGE_VALUE" not in serialized
    assert "CANARY_API_KEY_VALUE" not in serialized
    assert "RAW_SECURITY_ID_SHOULD_NOT_APPEAR" not in serialized
    assert "C:\\Users\\Meiosis\\secret\\resume.png" not in serialized
    assert "securityId=" not in serialized
    assert "cookie=" not in serialized
    assert "localStorage=" not in serialized
    assert "apiKey=" not in serialized
    assert "lastMessage" not in serialized


def test_preference_evidence_builder_does_not_import_llm_modules(monkeypatch) -> None:
    original_import = builtins.__import__

    def guarded_import(
        name: str,
        globals_: dict[str, Any] | None = None,
        locals_: dict[str, Any] | None = None,
        fromlist: tuple[str, ...] = (),
        level: int = 0,
    ):
        if name.startswith(("openai", "agents")):
            raise AssertionError(f"unexpected LLM import: {name}")
        return original_import(name, globals_, locals_, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", guarded_import)

    package = build_preference_evidence_package(
        recent_applications_artifact=recent_applications_artifact(),
        now="2026-07-08T10:00:00.000Z",
    )

    assert package.preferenceEvidenceUse == (
        "decision_evidence_only_not_application_authorization"
    )


def test_build_preference_evidence_package_from_file_and_cli(tmp_path: Path) -> None:
    source_path = tmp_path / "recent-applications.json"
    output_path = tmp_path / "preference-evidence.json"
    source_path.write_text(
        json.dumps(recent_applications_artifact(), ensure_ascii=False),
        encoding="utf-8",
    )

    package = build_preference_evidence_package_from_file(
        source_path,
        now="2026-07-08T10:00:00.000Z",
    )

    assert package.sourceFingerprint.sha256
    assert package.source.sourceArtifactIds[0].startswith("recent-applications:")

    exit_code = cli_main(
        [
            "build-preference-evidence",
            "--recent-applications",
            str(source_path),
            "--output",
            str(output_path),
            "--now",
            "2026-07-08T10:00:00.000Z",
        ]
    )

    assert exit_code == 0
    written = json.loads(output_path.read_text(encoding="utf-8"))
    assert written["schemaVersion"] == "preference-evidence-package.v1"
    assert written["sampleCounts"]["totalRecords"] == 5


def test_clarification_answers_are_persisted_and_indexed_as_evidence(
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "recent-applications.json"
    answers_path = tmp_path / "clarification-answers.json"
    output_path = tmp_path / "preference-evidence.json"
    source_path.write_text(
        json.dumps(recent_applications_artifact(), ensure_ascii=False),
        encoding="utf-8",
    )
    answer = build_preference_clarification_answer(
        answer_id="main-track-001",
        question_text="Should weak AI annotation roles remain only a backup?",
        recommended_answer_shown="Treat annotation as downrank unless it includes engineering.",
        user_answer=(
            "Yes. Prefer Python/LLM backend roles. Contact me at test@example.com "
            "only outside this artifact."
        ),
        affected_fields=["downrankPatterns", "mainTrackPreferences"],
        created_at="2026-07-08T10:02:00.000Z",
    )

    persisted = persist_preference_clarification_answer_to_file(answers_path, answer)
    package = build_preference_evidence_package_from_file(
        source_path,
        clarification_answers_path=answers_path,
        now="2026-07-08T10:03:00.000Z",
    )

    assert persisted.answers[0].evidenceRef == "ev-clarification-main-track-001"
    assert package.inputCoverage.clarificationAnswers is True
    assert package.sourceFingerprints["clarificationAnswers"]
    clarification_entries = [
        entry for entry in package.evidenceIndex if entry.type == "clarification_answer"
    ]
    assert [entry.id for entry in clarification_entries] == [
        "ev-clarification-main-track-001"
    ]
    assert clarification_entries[0].sourceRecordId == "main-track-001"
    assert "Python/LLM backend" in (clarification_entries[0].redactedValue or "")
    assert "test@example.com" not in package.model_dump_json()

    exit_code = cli_main(
        [
            "build-preference-evidence",
            "--recent-applications",
            str(source_path),
            "--clarification-answers",
            str(answers_path),
            "--output",
            str(output_path),
            "--now",
            "2026-07-08T10:03:00.000Z",
        ]
    )

    assert exit_code == 0
    written = json.loads(output_path.read_text(encoding="utf-8"))
    assert written["inputCoverage"]["clarificationAnswers"] is True
    assert written["evidenceIndex"][-1]["id"] == "ev-clarification-main-track-001"


def test_build_cold_start_preference_evidence_package_without_recent_applications(
    tmp_path: Path,
) -> None:
    candidate_statement_path = tmp_path / "candidate-statement.json"
    capability_profile_path = tmp_path / "capability-profile.json"
    target_jd_samples_path = tmp_path / "target-jd-samples.json"
    output_path = tmp_path / "preference-evidence.json"
    candidate_statement_path.write_text(
        json.dumps(candidate_statement_artifact(), ensure_ascii=False),
        encoding="utf-8",
    )
    capability_profile_path.write_text(
        json.dumps(capability_profile_artifact(), ensure_ascii=False),
        encoding="utf-8",
    )
    target_jd_samples_path.write_text(
        json.dumps(target_jd_samples_artifact(), ensure_ascii=False),
        encoding="utf-8",
    )

    package = build_preference_evidence_package(
        candidate_statement_artifact=candidate_statement_artifact(),
        capability_profile_artifact=capability_profile_artifact(),
        target_jd_samples_artifact=target_jd_samples_artifact(),
        now="2026-07-08T10:00:00.000Z",
    )

    assert package.source.kind == "cold_start_preference_inputs"
    assert package.inputCoverage.recentApplicationsWithJd is False
    assert package.inputCoverage.candidateStatement is True
    assert package.inputCoverage.capabilityProfile is True
    assert package.inputCoverage.targetJdSamples is True
    assert package.inputCoverage.recordsTotal == 2
    assert package.inputCoverage.recordsWithJd == 2
    assert package.inputCoverage.targetJdSampleCount == 2
    assert package.sampleCounts.totalRecords == 0
    assert package.sourceFingerprints["candidateStatement"]
    assert package.sourceFingerprints["capabilityProfile"]
    assert package.sourceFingerprints["targetJdSamples"]
    assert "recentApplications" not in package.sourceFingerprints

    evidence_ids = {entry.id for entry in package.evidenceIndex}
    assert "ev-candidate-statement" in evidence_ids
    assert "ev-capability-profile" in evidence_ids
    assert "ev-target-jd-sample-001" in evidence_ids
    assert "ev-target-jd-sample-002" in evidence_ids
    assert package.clusters.possibleMainTrack[0].id == "cluster-main-ai-backend"
    assert any(
        signal.id == "missing-recent-application-evidence"
        for signal in package.missingDataSignals
    )
    assert any(
        signal.id == "request-recent-application-evidence"
        for signal in package.requestedEvidence
    )

    exit_code = cli_main(
        [
            "build-preference-evidence",
            "--candidate-statement",
            str(candidate_statement_path),
            "--capability-profile",
            str(capability_profile_path),
            "--target-jd-samples",
            str(target_jd_samples_path),
            "--output",
            str(output_path),
            "--now",
            "2026-07-08T10:00:00.000Z",
        ]
    )

    assert exit_code == 0
    written = json.loads(output_path.read_text(encoding="utf-8"))
    assert written["inputCoverage"]["recentApplicationsWithJd"] is False
    assert written["inputCoverage"]["candidateStatement"] is True
    assert written["inputCoverage"]["capabilityProfile"] is True
    assert written["inputCoverage"]["targetJdSamples"] is True
    assert written["evidenceIndex"][0]["id"] == "ev-candidate-statement"


def test_cold_start_requires_candidate_statement_and_capability_profile() -> None:
    try:
        build_preference_evidence_package(
            target_jd_samples_artifact=target_jd_samples_artifact(),
            now="2026-07-08T10:00:00.000Z",
        )
    except ValueError as err:
        assert "candidate statement" in str(err)
        assert "capability profile" in str(err)
    else:
        raise AssertionError("expected cold-start evidence build to require inputs")


def recent_applications_artifact() -> dict[str, Any]:
    return {
        "schemaVersion": "recent-applications.v1",
        "ok": True,
        "command": "recent-applications",
        "captureMetadata": {
            "capturedAt": "2026-07-07T10:00:00.000Z",
            "limit": 100,
            "includeJd": True,
            "readOnly": True,
            "authorization": {
                "issuesApplicationAuthorization": False,
                "consumesApplicationAuthorizationToken": False,
            },
        },
        "statusSummary": {
            "total": 5,
            "ok": 5,
            "failed": 0,
            "blocked": 0,
            "skipped": 0,
            "pending": 0,
            "jd": {"ok": 5, "failed": 0, "blocked": 0, "skipped": 0, "pending": 0},
            "reasonCodes": {},
        },
        "records": [
            record(
                rank=1,
                conversation_id="conv-main",
                title="AI Agent 后端开发",
                company="Target Co",
                city="上海",
                position_category="后端开发",
                jd_text=(
                    "负责 Python FastAPI 服务开发、LLM Agent 工具接入和自动化工作流建设。"
                    "熟悉 RAG、数据管道和后端服务治理。"
                    "CANARY_FULL_JOB_DESCRIPTION C:\\Users\\Meiosis\\secret\\resume.png "
                    "cookie=CANARY_COOKIE_VALUE localStorage=CANARY_LOCAL_STORAGE_VALUE "
                    "apiKey=CANARY_API_KEY_VALUE"
                ),
            ),
            record(
                rank=2,
                conversation_id="conv-boundary",
                title="AIGC 数据评测实习生",
                company="Boundary Co",
                city="上海",
                position_category="测试",
                jd_text="负责大模型回答质量评估、数据标注、AIGC 测试和语料整理。",
            ),
            record(
                rank=3,
                conversation_id="conv-side",
                title="AI 日语翻译评测兼职",
                company="Side Co",
                city="远程",
                position_category="本地化",
                jd_text="远程兼职，负责大模型日语翻译评测、LQA、本地化质量检查。",
            ),
            record(
                rank=4,
                conversation_id="conv-side-only",
                title="日语 MTPE 远程兼职",
                company="Localization Co",
                city="远程",
                position_category="翻译",
                jd_text="负责日语翻译、本地化、MTPE、LQA，兼职远程。",
            ),
            record(
                rank=5,
                conversation_id="conv-exclude",
                title="客服销售运营",
                company="Generic Co",
                city="上海",
                position_category="运营",
                jd_text=(
                    "负责电话销售、客户服务、数据录入和日常运营。"
                    "https://www.zhipin.com/job_detail/abc.html?securityId="
                    "RAW_SECURITY_ID_SHOULD_NOT_APPEAR"
                ),
            ),
        ],
    }


def candidate_statement_artifact() -> dict[str, Any]:
    return {
        "schemaVersion": "candidate-statement.v1",
        "statement": (
            "Main track: Python backend and LLM Agent internships or junior roles. "
            "Side track: remote Japanese localization only if clearly part-time. "
            "Avoid generic sales or customer service."
        ),
        "constraints": ["Shanghai or remote", "No generic operations roles"],
    }


def capability_profile_artifact() -> dict[str, Any]:
    return {
        "schemaVersion": "candidate-capability-profile.v1",
        "profile": {
            "demonstratedAbilities": [
                {
                    "ability": "Python backend automation",
                    "evidenceSummary": (
                        "Built FastAPI services and workflow automation projects."
                    ),
                }
            ],
            "supportingEvidenceSummaries": [
                "Project evidence shows API development and data-processing automation."
            ],
            "targetRoleDirection": "Python backend and AI agent roles",
            "transferableStrengths": ["Workflow automation", "API integration"],
            "gaps": ["No durable evidence for Java enterprise ownership"],
            "framingBoundaries": [
                "Do not claim senior tenure, certifications, or guaranteed availability."
            ],
        },
    }


def target_jd_samples_artifact() -> dict[str, Any]:
    return {
        "schemaVersion": "target-jd-samples.v1",
        "samples": [
            {
                "sampleId": "target-main-ai-backend",
                "title": "Python LLM Agent 后端实习",
                "company": "Target Sample Co",
                "city": "上海",
                "positionCategory": "后端开发",
                "jd": {
                    "text": (
                        "负责 Python FastAPI 后端服务、LLM Agent 工具链和 RAG "
                        "数据管道建设。"
                    )
                },
            },
            {
                "sampleId": "target-side-localization",
                "title": "日语 LQA 远程兼职",
                "company": "Side Sample Co",
                "city": "远程",
                "positionCategory": "本地化",
                "jd": {"text": "远程兼职，负责日语本地化、MTPE 和 LQA 质量检查。"},
            },
        ],
    }


def record(
    *,
    rank: int,
    conversation_id: str,
    title: str,
    company: str,
    city: str,
    position_category: str,
    jd_text: str,
) -> dict[str, Any]:
    return {
        "rank": rank,
        "status": "ok",
        "conversationId": conversation_id,
        "timestampIso": "2026-07-07T10:00:00.000Z",
        "title": title,
        "company": company,
        "city": city,
        "positionCategory": position_category,
        "lastMessage": {
            "text": "这是一段完整聊天记录，不应进入 Preference Evidence Package",
            "direction": "boss",
        },
        "jobIdentityAnchor": {
            "jobId": conversation_id,
            "encryptJobId": conversation_id,
            "hasSecurityId": True,
            "securityIdRedacted": "RAW_SECURITY_ID_SHOULD_NOT_APPEAR",
        },
        "jd": {
            "status": "ok",
            "source": "boss_job_detail_dom",
            "text": jd_text,
            "characterCount": len(jd_text),
            "resolvedUrl": (
                "https://www.zhipin.com/job_detail/abc.html?"
                "securityId=RAW_SECURITY_ID_SHOULD_NOT_APPEAR"
            ),
        },
    }
