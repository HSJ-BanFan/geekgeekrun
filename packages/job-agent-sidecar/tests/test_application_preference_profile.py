from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ggr_sidecar.application_preferences import (
    build_preference_evidence_package,
    generate_application_preference_profile_from_file,
)
from ggr_sidecar.cli import main as cli_main

from test_preference_evidence_package import recent_applications_artifact


def test_generate_application_preference_profile_writes_valid_artifact(
    tmp_path: Path,
) -> None:
    evidence_path = write_evidence_package(tmp_path)
    output_path = tmp_path / "application-preference-profile.json"

    result = generate_application_preference_profile_from_file(
        evidence_path,
        output_path=output_path,
        llm_client=lambda _messages: valid_profile_payload(evidence_path),
    )

    assert result.ok is True
    assert result.status == "ok"
    assert result.profile is not None
    assert output_path.exists()

    written = json.loads(output_path.read_text(encoding="utf-8"))
    assert written["schemaVersion"] == "application-preference-profile.v1"
    assert written["freshnessMetadata"]["promptVersion"] == (
        "application-preference-profile.prompt.v1"
    )
    assert written["freshnessMetadata"]["cleanerVersion"] == (
        "preference-evidence-cleaner.v1"
    )
    assert written["freshnessMetadata"]["evidencePackageId"].startswith("pep-")
    assert written["freshnessMetadata"]["sourceFingerprints"]["recentApplications"]
    assert written["preferenceEvidenceUse"] == (
        "decision_evidence_only_not_application_authorization"
    )
    assert written["preferenceActionSuggestions"][0]["nonAuthorizing"] is True
    assert written["preferenceActionSuggestions"][0]["grantsApplicationAuthorization"] is False

    for field in [
        "mainTrackPreferences",
        "sideTrackPreferences",
        "sideTrackOnlyPatterns",
        "excludePatterns",
        "downrankPatterns",
    ]:
        for item in written[field]:
            assert set(item) == {
                "label",
                "track",
                "rationale",
                "evidenceRefs",
                "confidence",
                "constraints",
                "negativeSignals",
            }
            assert item["evidenceRefs"]


def test_profile_validation_rejects_invented_evidence_refs(tmp_path: Path) -> None:
    evidence_path = write_evidence_package(tmp_path)
    output_path = tmp_path / "profile.json"
    payload = valid_profile_payload(evidence_path)
    payload["mainTrackPreferences"][0]["evidenceRefs"] = ["ev-invented"]

    result = generate_application_preference_profile_from_file(
        evidence_path,
        output_path=output_path,
        llm_client=lambda _messages: payload,
    )

    assert result.ok is False
    assert result.status == "invalid_evidence_refs"
    assert output_path.exists() is False
    assert result.validationErrors
    assert result.validationErrors[0].loc == [
        "mainTrackPreferences",
        0,
        "evidenceRefs",
        0,
    ]


def test_profile_generation_rejects_malformed_output_without_writing(
    tmp_path: Path,
) -> None:
    evidence_path = write_evidence_package(tmp_path)
    output_path = tmp_path / "profile.json"

    result = generate_application_preference_profile_from_file(
        evidence_path,
        output_path=output_path,
        llm_client=lambda _messages: {
            "schemaVersion": "application-preference-profile.v1",
            "mainTrackPreferences": [],
        },
    )

    assert result.ok is False
    assert result.status == "schema_error"
    assert output_path.exists() is False


def test_profile_generation_does_not_persist_raw_llm_response(
    tmp_path: Path,
) -> None:
    evidence_path = write_evidence_package(tmp_path)
    output_path = tmp_path / "profile.json"
    payload = valid_profile_payload(evidence_path)
    raw_response = (
        "CANARY_RAW_UNVALIDATED_MODEL_RESPONSE\n"
        f"{json.dumps(payload, ensure_ascii=False)}\n"
        "CANARY_FULL_PROMPT_INPUT"
    )

    result = generate_application_preference_profile_from_file(
        evidence_path,
        output_path=output_path,
        llm_client=lambda _messages: raw_response,
    )

    assert result.ok is True
    written = output_path.read_text(encoding="utf-8")
    assert "CANARY_RAW_UNVALIDATED_MODEL_RESPONSE" not in written
    assert "CANARY_FULL_PROMPT_INPUT" not in written


def test_generate_application_preference_profile_cli_accepts_response_file(
    tmp_path: Path,
) -> None:
    evidence_path = write_evidence_package(tmp_path)
    output_path = tmp_path / "profile.json"
    response_path = tmp_path / "llm-response.json"
    response_path.write_text(
        json.dumps(valid_profile_payload(evidence_path), ensure_ascii=False),
        encoding="utf-8",
    )

    exit_code = cli_main(
        [
            "generate-application-preference-profile",
            "--evidence-package",
            str(evidence_path),
            "--llm-response",
            str(response_path),
            "--output",
            str(output_path),
        ]
    )

    assert exit_code == 0
    written = json.loads(output_path.read_text(encoding="utf-8"))
    assert written["profileId"] == "app-pref-test"


def write_evidence_package(tmp_path: Path) -> Path:
    package = build_preference_evidence_package(
        recent_applications_artifact=recent_applications_artifact(),
        now="2026-07-08T10:00:00.000Z",
    )
    path = tmp_path / "preference-evidence-package.json"
    path.write_text(
        json.dumps(package.model_dump(exclude_none=True), ensure_ascii=False),
        encoding="utf-8",
    )
    return path


def valid_profile_payload(evidence_path: Path) -> dict[str, Any]:
    package = json.loads(evidence_path.read_text(encoding="utf-8"))
    refs = [entry["id"] for entry in package["evidenceIndex"]]
    return {
        "schemaVersion": "application-preference-profile.v1",
        "profileId": "app-pref-test",
        "generatedAt": "2026-07-08T10:01:00.000Z",
        "modelScene": "application_preference_profile",
        "profileConfidence": "medium",
        "evidenceStrength": {
            "recentApplicationsWithJd": "strong",
            "candidateStatement": "missing",
            "capabilityProfile": "missing",
            "targetJdSamples": "missing",
            "clarificationAnswers": "missing",
        },
        "mainTrackPreferences": [
            preference_item(
                label="AI/LLM backend and data workflow roles",
                track="main",
                refs=refs[:2],
            )
        ],
        "sideTrackPreferences": [
            preference_item(
                label="AI language evaluation side track",
                track="side",
                refs=refs[4:6],
            )
        ],
        "sideTrackOnlyPatterns": [
            preference_item(
                label="Remote MTPE and LQA work stays side-track only",
                track="side_track_only",
                refs=refs[6:8],
            )
        ],
        "excludePatterns": [
            preference_item(
                label="Generic sales, service, and operations",
                track="exclude",
                refs=refs[-2:],
                negative_signals=["generic non-target work"],
            )
        ],
        "downrankPatterns": [
            preference_item(
                label="Weak AI annotation or audit work",
                track="downrank",
                refs=refs[2:4],
                negative_signals=["limited engineering growth"],
            )
        ],
        "uncertainties": [
            {
                "label": "Candidate statement missing",
                "reason": "No explicit current preference statement was present.",
                "evidenceRefs": [],
                "impact": "Could change main-track confidence.",
            }
        ],
        "preferenceActionSuggestions": [
            {
                "type": "search_keyword",
                "suggestion": "Python FastAPI LLM Agent",
                "rationale": "Matches the strongest main-track cluster.",
                "evidenceRefs": refs[:2],
                "nonAuthorizing": True,
                "grantsApplicationAuthorization": False,
            }
        ],
        "summary": (
            "Decision Evidence only: recent applications support AI backend as the "
            "main track while remote localization remains side-track only."
        ),
        "freshnessMetadata": {
            "promptVersion": "application-preference-profile.prompt.v1",
            "cleanerVersion": package["cleanerVersion"],
            "evidencePackageId": package["packageId"],
            "evidencePackageGeneratedAt": package["generatedAt"],
            "sourceFingerprints": package["sourceFingerprints"],
            "staleReasons": [],
        },
        "preferenceEvidenceUse": (
            "decision_evidence_only_not_application_authorization"
        ),
    }


def preference_item(
    *,
    label: str,
    track: str,
    refs: list[str],
    negative_signals: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "label": label,
        "track": track,
        "rationale": "Supported by normalized clusters and representative evidence.",
        "evidenceRefs": refs,
        "confidence": "medium",
        "constraints": ["Requires per-job evaluation before any application action."],
        "negativeSignals": negative_signals or [],
    }
