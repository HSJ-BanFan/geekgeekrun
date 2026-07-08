from __future__ import annotations

import re
import sqlite3
import hashlib
import json
import os
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .schemas import FlexibleCliModel, ValidationFailure


class RecentAppliedJob(FlexibleCliModel):
    applicationLogId: int
    appliedAt: str | None = None
    jobId: str | None = None
    title: str | None = None
    positionName: str | None = None
    companyName: str | None = None
    bossTitle: str | None = None
    address: str | None = None
    salaryLow: int | None = None
    salaryHigh: int | None = None
    salaryMonth: int | None = None
    experienceName: str | None = None
    degreeName: str | None = None
    chatStartupFrom: int | None = None
    jobSource: int | None = None
    hireStatus: int | None = None
    jdSummary: str | None = None
    jdEvidenceSnippets: list[str] = Field(default_factory=list)
    jdOriginalCharacterCount: int = 0
    jdOmittedCharacterCount: int = 0


class PreferenceTerm(FlexibleCliModel):
    term: str
    count: int
    sampleJobIds: list[str] = Field(default_factory=list)


class ApplicationPreferenceReview(FlexibleCliModel):
    ok: bool
    status: Literal["ready", "missing_db", "schema_error"]
    dbPath: str
    requestedLimit: int
    sampleSize: int = 0
    availableJdCount: int = 0
    applicationSourceCounts: dict[str, int] = Field(default_factory=dict)
    jobSourceCounts: dict[str, int] = Field(default_factory=dict)
    hireStatusCounts: dict[str, int] = Field(default_factory=dict)
    cityCounts: dict[str, int] = Field(default_factory=dict)
    experienceCounts: dict[str, int] = Field(default_factory=dict)
    degreeCounts: dict[str, int] = Field(default_factory=dict)
    salaryBands: dict[str, int] = Field(default_factory=dict)
    topTitleTerms: list[PreferenceTerm] = Field(default_factory=list)
    topJdTerms: list[PreferenceTerm] = Field(default_factory=list)
    jobs: list[RecentAppliedJob] = Field(default_factory=list)
    preferenceEvidenceUse: str = (
        "decision_evidence_only_not_application_authorization"
    )
    warnings: list[str] = Field(default_factory=list)
    summary: str


SelectionReason = Literal["strongest", "boundary", "contradiction"]
PreferenceTrack = Literal[
    "main",
    "side",
    "side_track_only",
    "downrank",
    "exclude",
]


class PreferenceSourceMetadata(FlexibleCliModel):
    kind: Literal["recent_applications_with_jd"] = "recent_applications_with_jd"
    artifactSchemaVersion: str | None = None
    capturedAt: str | None = None
    readOnly: bool | None = None
    sourceArtifactIds: list[str] = Field(default_factory=list)
    authorization: dict[str, bool] = Field(default_factory=dict)


class PreferenceInputCoverage(FlexibleCliModel):
    recentApplicationsWithJd: bool
    candidateStatement: bool = False
    capabilityProfile: bool = False
    targetJdSamples: bool = False
    clarificationAnswers: bool = False
    recordsTotal: int = 0
    recordsWithJd: int = 0


class PreferenceSampleCounts(FlexibleCliModel):
    totalRecords: int = 0
    okRecords: int = 0
    recordsWithJd: int = 0
    failedRecords: int = 0
    blockedRecords: int = 0
    skippedRecords: int = 0
    pendingRecords: int = 0


class SourceFingerprint(FlexibleCliModel):
    algorithm: Literal["sha256"] = "sha256"
    sha256: str


class PreferenceClarificationAnswer(FlexibleCliModel):
    answerId: str
    questionText: str
    recommendedAnswerShown: str
    userAnswer: str
    affectedFields: list[str] = Field(default_factory=list)
    createdAt: str
    evidenceRef: str


class PreferenceClarificationAnswersArtifact(FlexibleCliModel):
    schemaVersion: Literal["preference-clarification-answers.v1"] = (
        "preference-clarification-answers.v1"
    )
    answers: list[PreferenceClarificationAnswer] = Field(default_factory=list)


class PreferenceNormalizedCounts(FlexibleCliModel):
    titleSignals: dict[str, int] = Field(default_factory=dict)
    categorySignals: dict[str, int] = Field(default_factory=dict)
    jdSignals: dict[str, int] = Field(default_factory=dict)
    city: dict[str, int] = Field(default_factory=dict)
    remotePartTime: dict[str, int] = Field(default_factory=dict)
    internshipNewGrad: dict[str, int] = Field(default_factory=dict)
    languageLocalization: dict[str, int] = Field(default_factory=dict)
    aiLlmAgent: dict[str, int] = Field(default_factory=dict)
    backendData: dict[str, int] = Field(default_factory=dict)
    annotationEvaluation: dict[str, int] = Field(default_factory=dict)
    genericNonTarget: dict[str, int] = Field(default_factory=dict)


class PreferenceEvidenceIndexEntry(FlexibleCliModel):
    id: str
    type: Literal["record_summary", "jd_snippet", "clarification_answer"]
    sourceRecordId: str
    recordRank: int | None = None
    field: str
    redactedValue: str | None = None
    signalIds: list[str] = Field(default_factory=list)


class PreferenceCluster(FlexibleCliModel):
    id: str
    label: str
    track: PreferenceTrack
    count: int
    signalIds: list[str] = Field(default_factory=list)
    evidenceRefs: list[str] = Field(default_factory=list)
    sampleExampleIds: list[str] = Field(default_factory=list)


class PreferenceClusterGroups(FlexibleCliModel):
    possibleMainTrack: list[PreferenceCluster] = Field(default_factory=list)
    sideTrack: list[PreferenceCluster] = Field(default_factory=list)
    sideTrackOnly: list[PreferenceCluster] = Field(default_factory=list)
    downrank: list[PreferenceCluster] = Field(default_factory=list)
    exclude: list[PreferenceCluster] = Field(default_factory=list)


class RepresentativeExample(FlexibleCliModel):
    id: str
    clusterId: str
    selectionReason: SelectionReason
    title: str
    company: str
    city: str
    normalizedSignals: list[str] = Field(default_factory=list)
    redactedSnippets: list[str] = Field(default_factory=list)
    evidenceRefs: list[str] = Field(default_factory=list)


class PreferenceSignal(FlexibleCliModel):
    id: str
    label: str
    evidenceRefs: list[str] = Field(default_factory=list)


class PreferenceEvidencePackage(FlexibleCliModel):
    schemaVersion: Literal["preference-evidence-package.v1"] = (
        "preference-evidence-package.v1"
    )
    packageId: str
    generatedAt: str
    cleanerVersion: Literal["preference-evidence-cleaner.v1"] = (
        "preference-evidence-cleaner.v1"
    )
    source: PreferenceSourceMetadata
    inputCoverage: PreferenceInputCoverage
    sampleCounts: PreferenceSampleCounts
    sourceFingerprint: SourceFingerprint
    sourceFingerprints: dict[str, str] = Field(default_factory=dict)
    normalizedCounts: PreferenceNormalizedCounts
    clusters: PreferenceClusterGroups
    representativeExamples: list[RepresentativeExample] = Field(default_factory=list)
    conflictSignals: list[PreferenceSignal] = Field(default_factory=list)
    missingDataSignals: list[PreferenceSignal] = Field(default_factory=list)
    evidenceIndex: list[PreferenceEvidenceIndexEntry] = Field(default_factory=list)
    preferenceEvidenceUse: str = (
        "decision_evidence_only_not_application_authorization"
    )


PreferenceConfidence = Literal["low", "medium", "high"]
EvidenceStrengthValue = Literal["missing", "weak", "moderate", "strong"]
ApplicationPreferenceProfileStatus = Literal[
    "ok",
    "evidence_package_error",
    "llm_unavailable",
    "llm_error",
    "parse_error",
    "schema_error",
    "invalid_evidence_refs",
    "write_error",
]

APPLICATION_PREFERENCE_PROFILE_SCHEMA_VERSION = "application-preference-profile.v1"
APPLICATION_PREFERENCE_PROFILE_PROMPT_VERSION = (
    "application-preference-profile.prompt.v1"
)
APPLICATION_PREFERENCE_PROFILE_MODEL_SCENE = "application_preference_profile"


class StrictPreferenceModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ApplicationPreferenceEvidenceStrength(StrictPreferenceModel):
    recentApplicationsWithJd: EvidenceStrengthValue
    candidateStatement: EvidenceStrengthValue
    capabilityProfile: EvidenceStrengthValue
    targetJdSamples: EvidenceStrengthValue
    clarificationAnswers: EvidenceStrengthValue


class ApplicationPreferenceItem(StrictPreferenceModel):
    label: str
    track: PreferenceTrack
    rationale: str
    evidenceRefs: list[str] = Field(min_length=1)
    confidence: PreferenceConfidence
    constraints: list[str] = Field(default_factory=list)
    negativeSignals: list[str] = Field(default_factory=list)


class ApplicationPreferenceUncertainty(StrictPreferenceModel):
    label: str
    reason: str
    evidenceRefs: list[str] = Field(default_factory=list)
    impact: str


class ApplicationPreferenceActionSuggestion(StrictPreferenceModel):
    type: Literal[
        "search_keyword",
        "include_signal",
        "downrank_signal",
        "side_track_query",
        "greeting_framing_hint",
        "resume_framing_hint",
        "target_jd_sample_request",
    ]
    suggestion: str
    rationale: str
    evidenceRefs: list[str] = Field(default_factory=list)
    nonAuthorizing: Literal[True] = True
    grantsApplicationAuthorization: Literal[False] = False


class ApplicationPreferenceFreshnessMetadata(StrictPreferenceModel):
    promptVersion: str
    cleanerVersion: str
    evidencePackageId: str
    evidencePackageGeneratedAt: str
    sourceFingerprints: dict[str, str] = Field(default_factory=dict)
    staleReasons: list[str] = Field(default_factory=list)


class ApplicationPreferenceProfile(StrictPreferenceModel):
    schemaVersion: Literal["application-preference-profile.v1"]
    profileId: str
    generatedAt: str
    modelScene: str = APPLICATION_PREFERENCE_PROFILE_MODEL_SCENE
    profileConfidence: PreferenceConfidence
    evidenceStrength: ApplicationPreferenceEvidenceStrength
    mainTrackPreferences: list[ApplicationPreferenceItem] = Field(default_factory=list)
    sideTrackPreferences: list[ApplicationPreferenceItem] = Field(default_factory=list)
    sideTrackOnlyPatterns: list[ApplicationPreferenceItem] = Field(default_factory=list)
    excludePatterns: list[ApplicationPreferenceItem] = Field(default_factory=list)
    downrankPatterns: list[ApplicationPreferenceItem] = Field(default_factory=list)
    uncertainties: list[ApplicationPreferenceUncertainty] = Field(default_factory=list)
    preferenceActionSuggestions: list[ApplicationPreferenceActionSuggestion] = Field(
        default_factory=list
    )
    summary: str
    freshnessMetadata: ApplicationPreferenceFreshnessMetadata
    preferenceEvidenceUse: Literal[
        "decision_evidence_only_not_application_authorization"
    ]


class ApplicationPreferenceProfileGenerationResult(FlexibleCliModel):
    ok: bool
    status: ApplicationPreferenceProfileStatus
    evidencePackagePath: str
    outputPath: str | None = None
    profile: ApplicationPreferenceProfile | None = None
    validationErrors: list[ValidationFailure] = Field(default_factory=list)
    error: str | None = None


class ApplicationPreferenceProfileStalenessResult(FlexibleCliModel):
    stale: bool
    staleReasons: list[str] = Field(default_factory=list)
    profileEvidencePackageId: str | None = None
    currentEvidencePackageId: str | None = None
    profileSourceFingerprints: dict[str, str] = Field(default_factory=dict)
    currentSourceFingerprints: dict[str, str] = Field(default_factory=dict)


class PreferenceClarificationQuestion(FlexibleCliModel):
    questionText: str
    recommendedAnswerShown: str
    affectedFields: list[str] = Field(default_factory=list)
    sourceEvidenceRefs: list[str] = Field(default_factory=list)
    reason: str


class ApplicationPreferenceProfileValidationError(ValueError):
    def __init__(
        self,
        status: ApplicationPreferenceProfileStatus,
        validation_errors: list[ValidationFailure],
    ) -> None:
        super().__init__(status)
        self.status = status
        self.validation_errors = validation_errors


class ApplicationPreferenceProfileLlmUnavailable(RuntimeError):
    pass


ApplicationPreferenceProfileLlmClient = Callable[[list[dict[str, str]]], Any]


def build_preference_clarification_answer(
    *,
    answer_id: str,
    question_text: str,
    recommended_answer_shown: str,
    user_answer: str,
    affected_fields: list[str],
    created_at: str | datetime | None = None,
) -> PreferenceClarificationAnswer:
    safe_answer_id = _stable_identifier(answer_id, fallback_prefix="answer")
    return PreferenceClarificationAnswer(
        answerId=safe_answer_id,
        questionText=_safe_preference_text(question_text, 300) or "",
        recommendedAnswerShown=(
            _safe_preference_text(recommended_answer_shown, 300) or ""
        ),
        userAnswer=_safe_preference_text(user_answer, 600) or "",
        affectedFields=[
            _stable_identifier(field, fallback_prefix="field")
            for field in affected_fields
            if _string(field)
        ][:12],
        createdAt=_iso_now(created_at),
        evidenceRef=f"ev-clarification-{safe_answer_id}",
    )


def persist_preference_clarification_answer_to_file(
    output_path: Path | str,
    answer: PreferenceClarificationAnswer | dict[str, Any],
) -> PreferenceClarificationAnswersArtifact:
    path = Path(output_path)
    new_answer = PreferenceClarificationAnswer.model_validate(answer)
    if path.exists():
        artifact = _parse_clarification_answers_artifact(
            json.loads(path.read_text(encoding="utf-8"))
        )
        answers = [
            existing
            for existing in artifact.answers
            if existing.answerId != new_answer.answerId
        ]
    else:
        answers = []
    artifact = PreferenceClarificationAnswersArtifact(
        answers=[*answers, new_answer],
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(artifact.model_dump(exclude_none=True), ensure_ascii=False, indent=2)
        + "\n",
        encoding="utf-8",
    )
    return artifact


def evaluate_application_preference_profile_staleness(
    profile: ApplicationPreferenceProfile | dict[str, Any] | Path | str,
    current_package: PreferenceEvidencePackage | dict[str, Any] | Path | str,
) -> ApplicationPreferenceProfileStalenessResult:
    parsed_profile = _coerce_application_preference_profile(profile)
    package = _coerce_preference_evidence_package(current_package)
    metadata = parsed_profile.freshnessMetadata
    reasons: list[str] = []
    if metadata.evidencePackageId != package.packageId:
        reasons.append("evidence_package_id_changed")
    if metadata.cleanerVersion != package.cleanerVersion:
        reasons.append("cleaner_version_changed")
    for key in sorted(
        set(metadata.sourceFingerprints).union(package.sourceFingerprints)
    ):
        if metadata.sourceFingerprints.get(key) != package.sourceFingerprints.get(key):
            reasons.append(f"source_fingerprint_changed:{key}")
    return ApplicationPreferenceProfileStalenessResult(
        stale=bool(reasons),
        staleReasons=reasons,
        profileEvidencePackageId=metadata.evidencePackageId,
        currentEvidencePackageId=package.packageId,
        profileSourceFingerprints=metadata.sourceFingerprints,
        currentSourceFingerprints=package.sourceFingerprints,
    )


def propose_preference_clarification_question(
    profile: ApplicationPreferenceProfile | dict[str, Any] | Path | str,
    package: PreferenceEvidencePackage | dict[str, Any] | Path | str | None = None,
) -> PreferenceClarificationQuestion | None:
    parsed_profile = _coerce_application_preference_profile(profile)
    if parsed_profile.uncertainties:
        uncertainty = parsed_profile.uncertainties[0]
        return PreferenceClarificationQuestion(
            questionText=(
                f"{uncertainty.label}: {uncertainty.impact} "
                "Which preference should the refreshed profile use?"
            ),
            recommendedAnswerShown=uncertainty.reason,
            affectedFields=["uncertainties"],
            sourceEvidenceRefs=uncertainty.evidenceRefs,
            reason="profile_uncertainty",
        )
    if package is not None:
        parsed_package = _coerce_preference_evidence_package(package)
        if parsed_package.missingDataSignals:
            signal = parsed_package.missingDataSignals[0]
            return PreferenceClarificationQuestion(
                questionText=(
                    f"{signal.label} What should the refreshed profile assume?"
                ),
                recommendedAnswerShown=(
                    "State only the preference correction that would change planning."
                ),
                affectedFields=["requestedEvidence", "uncertainties"],
                sourceEvidenceRefs=signal.evidenceRefs,
                reason="evidence_package_gap",
            )
    return None


def generate_application_preference_profile_from_file(
    evidence_package_path: Path | str,
    *,
    output_path: Path | str | None = None,
    llm_client: ApplicationPreferenceProfileLlmClient | None = None,
    prompt_version: str = APPLICATION_PREFERENCE_PROFILE_PROMPT_VERSION,
    model_scene: str = APPLICATION_PREFERENCE_PROFILE_MODEL_SCENE,
) -> ApplicationPreferenceProfileGenerationResult:
    path = Path(evidence_package_path)
    output = Path(output_path) if output_path is not None else None

    try:
        package = PreferenceEvidencePackage.model_validate(
            json.loads(path.read_text(encoding="utf-8"))
        )
    except (OSError, json.JSONDecodeError, ValidationError) as err:
        return ApplicationPreferenceProfileGenerationResult(
            ok=False,
            status="evidence_package_error",
            evidencePackagePath=str(path),
            outputPath=str(output) if output is not None else None,
            validationErrors=(
                _validation_failures_from_pydantic(err)
                if isinstance(err, ValidationError)
                else []
            ),
            error=_safe_warning(str(err)),
        )

    messages = _build_application_preference_profile_messages(
        package=package,
        prompt_version=prompt_version,
        model_scene=model_scene,
    )
    client = llm_client or _call_application_preference_profile_llm_from_env

    try:
        llm_output = client(messages)
    except ApplicationPreferenceProfileLlmUnavailable as err:
        return ApplicationPreferenceProfileGenerationResult(
            ok=False,
            status="llm_unavailable",
            evidencePackagePath=str(path),
            outputPath=str(output) if output is not None else None,
            error=_safe_warning(str(err)),
        )
    except Exception as err:  # pragma: no cover - provider/network dependent
        return ApplicationPreferenceProfileGenerationResult(
            ok=False,
            status="llm_error",
            evidencePackagePath=str(path),
            outputPath=str(output) if output is not None else None,
            error=_safe_warning(str(err)),
        )

    try:
        parsed_output = _coerce_llm_json_object(llm_output)
    except ValueError as err:
        return ApplicationPreferenceProfileGenerationResult(
            ok=False,
            status="parse_error",
            evidencePackagePath=str(path),
            outputPath=str(output) if output is not None else None,
            error=_safe_warning(str(err)),
        )

    try:
        profile = ApplicationPreferenceProfile.model_validate(parsed_output)
        _validate_application_preference_profile(
            profile=profile,
            package=package,
            prompt_version=prompt_version,
            model_scene=model_scene,
        )
    except ApplicationPreferenceProfileValidationError as err:
        return ApplicationPreferenceProfileGenerationResult(
            ok=False,
            status=err.status,
            evidencePackagePath=str(path),
            outputPath=str(output) if output is not None else None,
            validationErrors=err.validation_errors,
        )
    except ValidationError as err:
        return ApplicationPreferenceProfileGenerationResult(
            ok=False,
            status="schema_error",
            evidencePackagePath=str(path),
            outputPath=str(output) if output is not None else None,
            validationErrors=_validation_failures_from_pydantic(err),
        )

    if output is not None:
        try:
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(
                json.dumps(
                    profile.model_dump(exclude_none=True),
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
        except OSError as err:
            return ApplicationPreferenceProfileGenerationResult(
                ok=False,
                status="write_error",
                evidencePackagePath=str(path),
                outputPath=str(output),
                error=_safe_warning(str(err)),
            )

    return ApplicationPreferenceProfileGenerationResult(
        ok=True,
        status="ok",
        evidencePackagePath=str(path),
        outputPath=str(output) if output is not None else None,
        profile=profile,
    )


def _build_application_preference_profile_messages(
    *,
    package: PreferenceEvidencePackage,
    prompt_version: str,
    model_scene: str,
) -> list[dict[str, str]]:
    allowed_refs = [entry.id for entry in package.evidenceIndex]
    schema = ApplicationPreferenceProfile.model_json_schema()
    payload = {
        "preferenceEvidencePackage": package.model_dump(exclude_none=True),
        "requiredMetadata": {
            "schemaVersion": APPLICATION_PREFERENCE_PROFILE_SCHEMA_VERSION,
            "promptVersion": prompt_version,
            "modelScene": model_scene,
            "cleanerVersion": package.cleanerVersion,
            "evidencePackageId": package.packageId,
            "evidencePackageGeneratedAt": package.generatedAt,
            "sourceFingerprints": package.sourceFingerprints,
            "preferenceEvidenceUse": (
                "decision_evidence_only_not_application_authorization"
            ),
        },
        "allowedEvidenceRefs": allowed_refs,
        "jsonSchema": schema,
    }
    return [
        {
            "role": "system",
            "content": "\n".join(
                [
                    "Generate an Application Preference Profile as strict JSON.",
                    "Use only the redacted Preference Evidence Package.",
                    "Every preference item evidenceRefs value must come from allowedEvidenceRefs.",
                    "Do not invent evidence references. Put unsupported claims in uncertainties.",
                    "The profile is Decision Evidence only and grants no Application Authorization.",
                    "Return only one JSON object and no markdown.",
                ]
            ),
        },
        {
            "role": "user",
            "content": json.dumps(payload, ensure_ascii=False),
        },
    ]


def _call_application_preference_profile_llm_from_env(
    messages: list[dict[str, str]],
) -> str:
    api_key = os.environ.get("GGR_OPENAI_API_KEY") or os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise ApplicationPreferenceProfileLlmUnavailable(
            "Set GGR_OPENAI_API_KEY or OPENAI_API_KEY to generate a profile."
        )
    model = os.environ.get("GGR_OPENAI_MODEL") or os.environ.get("OPENAI_MODEL")
    if not model:
        raise ApplicationPreferenceProfileLlmUnavailable(
            "Set GGR_OPENAI_MODEL or OPENAI_MODEL to generate a profile."
        )
    base_url = (
        os.environ.get("GGR_OPENAI_BASE_URL")
        or os.environ.get("OPENAI_BASE_URL")
        or "https://api.openai.com/v1"
    ).rstrip("/")
    request = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=json.dumps(
            {
                "model": model,
                "messages": messages,
                "temperature": 0.1,
                "response_format": {"type": "json_object"},
            },
            ensure_ascii=False,
        ).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as err:
        raise RuntimeError(f"LLM request failed: {err}") from err
    content = payload.get("choices", [{}])[0].get("message", {}).get("content")
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("LLM response did not include message content.")
    return content


def _coerce_llm_json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        raise ValueError("LLM output must be a JSON object or string.")
    text = value.strip()
    if not text:
        raise ValueError("LLM output was empty.")
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text, flags=re.IGNORECASE)
    candidate = fenced.group(1).strip() if fenced else text
    extracted = _extract_first_json_object(candidate)
    if extracted is not None:
        candidate = extracted
    parsed = json.loads(candidate)
    if not isinstance(parsed, dict):
        raise ValueError("LLM JSON output must be an object.")
    return parsed


def _extract_first_json_object(text: str) -> str | None:
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    return None


def _validate_application_preference_profile(
    *,
    profile: ApplicationPreferenceProfile,
    package: PreferenceEvidencePackage,
    prompt_version: str,
    model_scene: str,
) -> None:
    metadata_errors: list[ValidationFailure] = []
    expected_metadata = {
        "promptVersion": prompt_version,
        "cleanerVersion": package.cleanerVersion,
        "evidencePackageId": package.packageId,
        "evidencePackageGeneratedAt": package.generatedAt,
        "sourceFingerprints": package.sourceFingerprints,
    }
    for field, expected_value in expected_metadata.items():
        actual_value = getattr(profile.freshnessMetadata, field)
        if actual_value != expected_value:
            metadata_errors.append(
                ValidationFailure(
                    loc=["freshnessMetadata", field],
                    msg="metadata does not match the evidence package",
                    type="value_error.metadata_mismatch",
                )
            )
    if profile.modelScene != model_scene:
        metadata_errors.append(
            ValidationFailure(
                loc=["modelScene"],
                msg="modelScene does not match the requested model scene",
                type="value_error.metadata_mismatch",
            )
        )
    if metadata_errors:
        raise ApplicationPreferenceProfileValidationError(
            "schema_error",
            metadata_errors,
        )

    ref_errors = _unknown_evidence_ref_errors(profile, package)
    if ref_errors:
        raise ApplicationPreferenceProfileValidationError(
            "invalid_evidence_refs",
            ref_errors,
        )


def _unknown_evidence_ref_errors(
    profile: ApplicationPreferenceProfile,
    package: PreferenceEvidencePackage,
) -> list[ValidationFailure]:
    allowed_refs = {entry.id for entry in package.evidenceIndex}
    errors: list[ValidationFailure] = []
    for field in [
        "mainTrackPreferences",
        "sideTrackPreferences",
        "sideTrackOnlyPatterns",
        "excludePatterns",
        "downrankPatterns",
        "uncertainties",
        "preferenceActionSuggestions",
    ]:
        values = getattr(profile, field)
        for item_index, item in enumerate(values):
            for ref_index, ref in enumerate(item.evidenceRefs):
                if ref not in allowed_refs:
                    errors.append(
                        ValidationFailure(
                            loc=[field, item_index, "evidenceRefs", ref_index],
                            msg=f"unknown evidenceRef: {ref}",
                            type="value_error.unknown_evidence_ref",
                        )
                    )
    return errors


def _validation_failures_from_pydantic(err: ValidationError) -> list[ValidationFailure]:
    failures: list[ValidationFailure] = []
    for item in err.errors():
        failures.append(
            ValidationFailure(
                loc=list(item.get("loc") or []),
                msg=str(item.get("msg") or ""),
                type=str(item.get("type") or "value_error"),
            )
        )
    return failures


def build_preference_evidence_package_from_file(
    recent_applications_path: Path | str,
    *,
    clarification_answers_path: Path | str | None = None,
    now: str | datetime | None = None,
) -> PreferenceEvidencePackage:
    path = Path(recent_applications_path)
    raw = path.read_bytes()
    artifact = json.loads(raw.decode("utf-8"))
    clarification_artifact = None
    if clarification_answers_path is not None:
        clarification_path = Path(clarification_answers_path)
        clarification_raw = clarification_path.read_bytes()
        clarification_artifact = json.loads(clarification_raw.decode("utf-8"))
    return build_preference_evidence_package(
        recent_applications_artifact=artifact,
        source_bytes=raw,
        clarification_answers_artifact=clarification_artifact,
        now=now,
    )


def build_preference_evidence_package(
    *,
    recent_applications_artifact: dict[str, Any],
    source_bytes: bytes | None = None,
    clarification_answers_artifact: (
        PreferenceClarificationAnswersArtifact | dict[str, Any] | None
    ) = None,
    now: str | datetime | None = None,
) -> PreferenceEvidencePackage:
    recent_applications_hash = _source_sha256(
        recent_applications_artifact,
        source_bytes,
    )
    clarification_answers = _normalize_clarification_answers(
        clarification_answers_artifact
    )
    clarification_answers_hash = (
        _source_sha256(
            _clarification_answers_fingerprint_payload(clarification_answers),
            None,
        )
        if clarification_answers
        else None
    )
    source_fingerprints = {"recentApplications": recent_applications_hash}
    if clarification_answers_hash is not None:
        source_fingerprints["clarificationAnswers"] = clarification_answers_hash
    source_hash = _combined_source_hash(source_fingerprints)
    records = [
        _normalize_preference_record(record, index)
        for index, record in enumerate(
            sorted(
                recent_applications_artifact.get("records") or [],
                key=lambda item: _int_or_none(item.get("rank")) or 999_999,
            ),
            start=1,
        )
    ]
    evidence_index = _build_evidence_index(records, clarification_answers)
    cluster_state = _build_preference_clusters(records)
    representatives = _build_representative_examples(cluster_state)
    clusters = _materialize_cluster_groups(cluster_state, representatives)
    source = _build_preference_source(
        recent_applications_artifact,
        recent_applications_hash,
        clarification_answers_hash=clarification_answers_hash,
    )

    return PreferenceEvidencePackage(
        packageId=f"pep-{source_hash[:16]}",
        generatedAt=_iso_now(now),
        source=source,
        inputCoverage=PreferenceInputCoverage(
            recentApplicationsWithJd=any(record["has_jd"] for record in records),
            clarificationAnswers=bool(clarification_answers),
            recordsTotal=len(records),
            recordsWithJd=sum(1 for record in records if record["has_jd"]),
        ),
        sampleCounts=_build_sample_counts(recent_applications_artifact, records),
        sourceFingerprint=SourceFingerprint(sha256=source_hash),
        sourceFingerprints=source_fingerprints,
        normalizedCounts=_build_normalized_counts(records),
        clusters=clusters,
        representativeExamples=representatives,
        conflictSignals=_build_conflict_signals(records, evidence_index),
        missingDataSignals=_build_missing_data_signals(records),
        evidenceIndex=evidence_index,
    )


_PREFERENCE_SIGNAL_PATTERNS: tuple[tuple[str, str], ...] = (
    (
        "ai_llm_agent",
        r"\b(ai|llm|agent|aigc|gpt|rag)\b|人工智能|大模型|智能体|生成式",
    ),
    (
        "backend_data",
        r"python|fastapi|django|flask|后端|服务端|backend|server|数据工程|数据管道|pipeline|etl|sql|自动化工作流",
    ),
    (
        "annotation_evaluation",
        r"数据标注|标注|评测|评估|evaluation|evaluate|audit|审核|ai训练|训练师|语料",
    ),
    (
        "language_localization",
        r"日语|日本语|英语|翻译|本地化|locali[sz]ation|mtpe|lqa",
    ),
    (
        "remote_part_time",
        r"远程|兼职|part[-\s]?time|外包|项目制",
    ),
    (
        "internship_new_grad",
        r"实习|实习生|校招|应届|新卒|new grad",
    ),
    (
        "generic_non_target",
        r"客服|销售|电销|运营|产品运营|录入|行政|助理|金融",
    ),
)

_PREFERENCE_SIGNAL_LABELS = {
    "ai_llm_agent": "AI/LLM/Agent",
    "backend_data": "Backend/Data",
    "annotation_evaluation": "Annotation/Evaluation",
    "language_localization": "Language/Localization",
    "remote_part_time": "Remote/Part-time",
    "internship_new_grad": "Internship/New-grad",
    "generic_non_target": "Generic non-target",
}

_SIGNAL_ORDER = [key for key, _pattern in _PREFERENCE_SIGNAL_PATTERNS]


def _normalize_preference_record(record: dict[str, Any], index: int) -> dict[str, Any]:
    title = _safe_preference_text(record.get("title"), 120)
    company = _safe_preference_text(record.get("company"), 120)
    city = _safe_preference_text(record.get("city"), 80)
    position_category = _safe_preference_text(record.get("positionCategory"), 120)
    jd_text = str((record.get("jd") or {}).get("text") or record.get("jdText") or "")
    title_haystack = " ".join(item for item in [title, position_category] if item)
    category_haystack = position_category or ""
    jd_haystack = jd_text
    title_signals = _extract_preference_signal_ids(title_haystack)
    category_signals = _extract_preference_signal_ids(category_haystack)
    jd_signals = _extract_preference_signal_ids(jd_haystack)
    signals = [key for key in _SIGNAL_ORDER if key in {*(title_signals), *(jd_signals)}]
    source_record_id = _preference_source_record_id(record, index)
    evidence_id = f"ev-record-{index:03d}"
    snippets = _select_preference_snippets(jd_text, signals)
    snippet_evidence_ids = [
        f"{evidence_id}-snippet-{snippet_index:02d}"
        for snippet_index, _snippet in enumerate(snippets, start=1)
    ]
    return {
        "id": f"record-{index:03d}",
        "rank": _int_or_none(record.get("rank")) or index,
        "source_record_id": source_record_id,
        "evidence_id": evidence_id,
        "snippet_evidence_ids": snippet_evidence_ids,
        "title": title,
        "company": company,
        "city": city,
        "position_category": position_category,
        "status": str(record.get("status") or "unknown"),
        "jd_status": str((record.get("jd") or {}).get("status") or "unknown"),
        "has_jd": bool(jd_text.strip()),
        "signals": signals,
        "title_signals": title_signals,
        "category_signals": category_signals,
        "jd_signals": jd_signals,
        "snippets": snippets,
        "strength": _preference_signal_strength(signals, jd_signals),
    }


def _build_evidence_index(
    records: list[dict[str, Any]],
    clarification_answers: list[PreferenceClarificationAnswer] | None = None,
) -> list[PreferenceEvidenceIndexEntry]:
    entries: list[PreferenceEvidenceIndexEntry] = []
    for record in records:
        summary_parts = [
            record["title"],
            record["company"],
            record["city"],
            record["position_category"],
        ]
        entries.append(
            PreferenceEvidenceIndexEntry(
                id=record["evidence_id"],
                type="record_summary",
                sourceRecordId=record["source_record_id"],
                recordRank=record["rank"],
                field="record_summary",
                redactedValue=" | ".join(part for part in summary_parts if part),
                signalIds=record["signals"],
            )
        )
        for index, snippet in enumerate(record["snippets"], start=1):
            entries.append(
                PreferenceEvidenceIndexEntry(
                    id=f"{record['evidence_id']}-snippet-{index:02d}",
                    type="jd_snippet",
                    sourceRecordId=record["source_record_id"],
                    recordRank=record["rank"],
                    field="jd.snippet",
                    redactedValue=snippet,
                    signalIds=record["signals"],
                )
            )
    for answer in clarification_answers or []:
        entries.append(
            PreferenceEvidenceIndexEntry(
                id=answer.evidenceRef,
                type="clarification_answer",
                sourceRecordId=answer.answerId,
                field="clarificationAnswer.userAnswer",
                redactedValue=_format_clarification_answer_evidence(answer),
                signalIds=_extract_preference_signal_ids(
                    " ".join(
                        [
                            answer.questionText,
                            answer.recommendedAnswerShown,
                            answer.userAnswer,
                            " ".join(answer.affectedFields),
                        ]
                    )
                ),
            )
        )
    return entries


def _build_preference_clusters(
    records: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    specs = [
        {
            "id": "cluster-main-ai-backend",
            "label": "AI/LLM agent backend or data roles",
            "track": "main",
            "signals": ["ai_llm_agent", "backend_data"],
            "predicate": lambda signals: (
                "ai_llm_agent" in signals
                and "backend_data" in signals
                and "generic_non_target" not in signals
            ),
        },
        {
            "id": "cluster-side-ai-language-evaluation",
            "label": "AI language or localization evaluation side track",
            "track": "side",
            "signals": [
                "ai_llm_agent",
                "language_localization",
                "annotation_evaluation",
                "remote_part_time",
            ],
            "predicate": lambda signals: (
                "ai_llm_agent" in signals
                and "language_localization" in signals
                and "backend_data" not in signals
            ),
        },
        {
            "id": "cluster-side-only-localization-mtpe",
            "label": "Remote localization, MTPE, or LQA side-track-only work",
            "track": "side_track_only",
            "signals": ["language_localization", "remote_part_time"],
            "predicate": lambda signals: (
                "language_localization" in signals
                and "remote_part_time" in signals
                and "ai_llm_agent" not in signals
                and "backend_data" not in signals
            ),
        },
        {
            "id": "cluster-downrank-annotation-evaluation",
            "label": "Annotation, audit, evaluation, or weak AI labeling",
            "track": "downrank",
            "signals": [
                "annotation_evaluation",
                "internship_new_grad",
                "ai_llm_agent",
            ],
            "predicate": lambda signals: (
                "annotation_evaluation" in signals
                and "backend_data" not in signals
            ),
        },
        {
            "id": "cluster-exclude-generic-non-target",
            "label": "Generic sales, customer service, operations, or data entry",
            "track": "exclude",
            "signals": ["generic_non_target"],
            "predicate": lambda signals: (
                "generic_non_target" in signals
                and "ai_llm_agent" not in signals
                and "backend_data" not in signals
                and "language_localization" not in signals
            ),
        },
    ]
    clusters: list[dict[str, Any]] = []
    for spec in specs:
        candidates = [
            record
            for record in records
            if spec["predicate"](set(record["signals"]))
        ]
        clusters.append({**spec, "records": candidates})
    return clusters


def _build_representative_examples(
    clusters: list[dict[str, Any]],
) -> list[RepresentativeExample]:
    examples: list[RepresentativeExample] = []
    used_ids: set[str] = set()

    for cluster in clusters:
        strongest = _select_strongest_record(cluster["records"])
        if strongest is not None:
            examples.append(
                _representative_example(cluster, strongest, "strongest", len(examples) + 1)
            )
            used_ids.add(f"{cluster['id']}:strongest:{strongest['id']}")

    boundary_candidates: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for cluster in clusters:
        boundary = _select_boundary_record(cluster["records"])
        if boundary is not None:
            boundary_candidates.append((cluster, boundary))

    for cluster, boundary in sorted(
        boundary_candidates,
        key=lambda item: (item[1]["rank"], item[0]["id"]),
    ):
        key = f"{cluster['id']}:boundary:{boundary['id']}"
        if key not in used_ids:
            examples.append(
                _representative_example(
                    cluster,
                    boundary,
                    "boundary",
                    len(examples) + 1,
                )
            )
            used_ids.add(key)

    contradiction_cluster = next(
        (
            cluster
            for cluster in clusters
            if cluster["track"] == "exclude" and cluster["records"]
        ),
        None,
    ) or next(
        (
            cluster
            for cluster in clusters
            if cluster["track"] == "downrank" and cluster["records"]
        ),
        None,
    ) or next(
        (
            cluster
            for cluster in clusters
            if cluster["track"] == "side_track_only" and cluster["records"]
        ),
        None,
    )
    if contradiction_cluster is not None:
        record = _select_strongest_record(contradiction_cluster["records"])
        if record is not None:
            examples.append(
                _representative_example(
                    contradiction_cluster,
                    record,
                    "contradiction",
                    len(examples) + 1,
                )
            )

    return examples


def _materialize_cluster_groups(
    clusters: list[dict[str, Any]],
    examples: list[RepresentativeExample],
) -> PreferenceClusterGroups:
    groups = PreferenceClusterGroups()
    for cluster in clusters:
        if not cluster["records"]:
            continue
        cluster_examples = [
            example.id for example in examples if example.clusterId == cluster["id"]
        ]
        evidence_refs = []
        for record in cluster["records"]:
            evidence_refs.append(record["evidence_id"])
            evidence_refs.extend(record["snippet_evidence_ids"][:1])
        materialized = PreferenceCluster(
            id=cluster["id"],
            label=cluster["label"],
            track=cluster["track"],
            count=len(cluster["records"]),
            signalIds=cluster["signals"],
            evidenceRefs=_unique(evidence_refs),
            sampleExampleIds=cluster_examples,
        )
        if cluster["track"] == "main":
            groups.possibleMainTrack.append(materialized)
        elif cluster["track"] == "side":
            groups.sideTrack.append(materialized)
        elif cluster["track"] == "side_track_only":
            groups.sideTrackOnly.append(materialized)
        elif cluster["track"] == "downrank":
            groups.downrank.append(materialized)
        elif cluster["track"] == "exclude":
            groups.exclude.append(materialized)
    return groups


def _representative_example(
    cluster: dict[str, Any],
    record: dict[str, Any],
    reason: SelectionReason,
    index: int,
) -> RepresentativeExample:
    return RepresentativeExample(
        id=f"example-{index:03d}",
        clusterId=cluster["id"],
        selectionReason=reason,
        title=record["title"],
        company=record["company"],
        city=record["city"],
        normalizedSignals=record["signals"],
        redactedSnippets=record["snippets"],
        evidenceRefs=[record["evidence_id"], *record["snippet_evidence_ids"]],
    )


def _select_strongest_record(records: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not records:
        return None
    return sorted(
        records,
        key=lambda record: (-record["strength"], record["rank"], record["id"]),
    )[0]


def _select_boundary_record(records: list[dict[str, Any]]) -> dict[str, Any] | None:
    boundary_records = [
        record
        for record in records
        if _is_boundary_signal_set(set(record["signals"]))
    ]
    if not boundary_records:
        return None
    return sorted(
        boundary_records,
        key=lambda record: (record["rank"], -record["strength"], record["id"]),
    )[0]


def _is_boundary_signal_set(signals: set[str]) -> bool:
    return (
        ("ai_llm_agent" in signals and "annotation_evaluation" in signals)
        or ("ai_llm_agent" in signals and "language_localization" in signals)
        or ("remote_part_time" in signals and "language_localization" in signals)
    )


def _build_preference_source(
    artifact: dict[str, Any],
    source_hash: str,
    *,
    clarification_answers_hash: str | None = None,
) -> PreferenceSourceMetadata:
    metadata = artifact.get("captureMetadata") or {}
    authorization = metadata.get("authorization") or {}
    source_artifact_ids = [f"recent-applications:{source_hash[:16]}"]
    if clarification_answers_hash is not None:
        source_artifact_ids.append(
            f"preference-clarification-answers:{clarification_answers_hash[:16]}"
        )
    return PreferenceSourceMetadata(
        artifactSchemaVersion=_string(artifact.get("schemaVersion")),
        capturedAt=_string(metadata.get("capturedAt")),
        readOnly=metadata.get("readOnly") if isinstance(metadata.get("readOnly"), bool) else None,
        sourceArtifactIds=source_artifact_ids,
        authorization={
            "issuesApplicationAuthorization": bool(
                authorization.get("issuesApplicationAuthorization")
            ),
            "consumesApplicationAuthorizationToken": bool(
                authorization.get("consumesApplicationAuthorizationToken")
            ),
        },
    )


def _build_sample_counts(
    artifact: dict[str, Any],
    records: list[dict[str, Any]],
) -> PreferenceSampleCounts:
    summary = artifact.get("statusSummary") or {}
    return PreferenceSampleCounts(
        totalRecords=len(records),
        okRecords=_summary_count(
            summary,
            "ok",
            sum(1 for record in records if record["status"] == "ok"),
        ),
        recordsWithJd=sum(1 for record in records if record["has_jd"]),
        failedRecords=_summary_count(
            summary,
            "failed",
            sum(1 for record in records if record["status"] == "failed"),
        ),
        blockedRecords=_summary_count(
            summary,
            "blocked",
            sum(1 for record in records if record["status"] == "blocked"),
        ),
        skippedRecords=_summary_count(
            summary,
            "skipped",
            sum(1 for record in records if record["status"] == "skipped"),
        ),
        pendingRecords=_summary_count(
            summary,
            "pending",
            sum(1 for record in records if record["status"] == "pending"),
        ),
    )


def _summary_count(summary: dict[str, Any], key: str, fallback: int) -> int:
    value = _int_or_none(summary.get(key))
    return fallback if value is None else value


def _build_normalized_counts(
    records: list[dict[str, Any]],
) -> PreferenceNormalizedCounts:
    return PreferenceNormalizedCounts(
        titleSignals=_count_signal_presence(records, "title_signals"),
        categorySignals=_count_signal_presence(records, "category_signals"),
        jdSignals=_count_signal_presence(records, "jd_signals"),
        city=_counter_map(record["city"] or "unknown" for record in records),
        remotePartTime=_present_absent_counts(records, "remote_part_time"),
        internshipNewGrad=_present_absent_counts(records, "internship_new_grad"),
        languageLocalization=_present_absent_counts(records, "language_localization"),
        aiLlmAgent=_present_absent_counts(records, "ai_llm_agent"),
        backendData=_present_absent_counts(records, "backend_data"),
        annotationEvaluation=_present_absent_counts(records, "annotation_evaluation"),
        genericNonTarget=_present_absent_counts(records, "generic_non_target"),
    )


def _build_conflict_signals(
    records: list[dict[str, Any]],
    evidence_index: list[PreferenceEvidenceIndexEntry],
) -> list[PreferenceSignal]:
    signals: list[PreferenceSignal] = []
    all_signal_sets = [set(record["signals"]) for record in records]
    evidence_refs = [entry.id for entry in evidence_index if entry.type == "record_summary"]
    has_main = any(
        "ai_llm_agent" in item and "backend_data" in item
        for item in all_signal_sets
    )
    has_non_target = any(
        "generic_non_target" in item or "annotation_evaluation" in item
        for item in all_signal_sets
    )
    has_side = any(
        "language_localization" in item and "remote_part_time" in item
        for item in all_signal_sets
    )
    if has_main and has_non_target:
        signals.append(
            PreferenceSignal(
                id="conflict-main-track-mixed-with-downrank-or-exclude",
                label="Main-track evidence is mixed with downrank or exclude evidence.",
                evidenceRefs=evidence_refs[:12],
            )
        )
    if has_main and has_side:
        signals.append(
            PreferenceSignal(
                id="conflict-main-track-mixed-with-side-track",
                label="Main-track evidence is mixed with remote language side-track evidence.",
                evidenceRefs=evidence_refs[:12],
            )
        )
    return signals


def _build_missing_data_signals(
    records: list[dict[str, Any]],
) -> list[PreferenceSignal]:
    signals: list[PreferenceSignal] = []
    if not records:
        signals.append(
            PreferenceSignal(
                id="missing-recent-applications",
                label="No recent application records were available.",
            )
        )
        return signals
    missing_jd_refs = [
        record["evidence_id"] for record in records if not record["has_jd"]
    ]
    if missing_jd_refs:
        signals.append(
            PreferenceSignal(
                id="missing-jd-text",
                label="Some recent application records did not include JD text.",
                evidenceRefs=missing_jd_refs[:12],
            )
        )
    if not any("backend_data" in record["signals"] for record in records):
        signals.append(
            PreferenceSignal(
                id="missing-backend-data-main-track-evidence",
                label="No backend/data main-track evidence was found.",
            )
        )
    return signals


def _extract_preference_signal_ids(text: str) -> list[str]:
    normalized = _normalize_text(text).lower()
    return [
        key
        for key, pattern in _PREFERENCE_SIGNAL_PATTERNS
        if re.search(pattern, normalized, flags=re.IGNORECASE)
    ]


def _preference_signal_strength(signals: list[str], jd_signals: list[str]) -> int:
    weights = {
        "ai_llm_agent": 4,
        "backend_data": 4,
        "language_localization": 3,
        "annotation_evaluation": 2,
        "remote_part_time": 1,
        "internship_new_grad": 1,
        "generic_non_target": 1,
    }
    return sum(weights.get(signal, 1) for signal in signals) + len(jd_signals)


def _select_preference_snippets(text: str, signals: list[str]) -> list[str]:
    redacted = _redact_sensitive_fragments(_normalize_text(text))
    if not redacted:
        return []
    segments = [
        _normalize_text(segment)
        for segment in re.split(r"[\r\n。；;.!！?？]+", redacted)
        if segment.strip()
    ]
    selected: list[str] = []
    for segment in segments:
        segment_signals = set(_extract_preference_signal_ids(segment))
        if segment_signals.intersection(signals):
            selected.append(_partial_preference_snippet(segment, redacted))
        if len(selected) >= 3:
            break
    if not selected:
        selected = [_partial_preference_snippet(redacted, redacted)]
    return _unique(selected)[:3]


def _partial_preference_snippet(value: str, full_text: str) -> str:
    snippet = _clip(value, 120)
    if _normalize_text(value) != _normalize_text(full_text):
        return snippet
    prefix = _normalize_text(value)[:80].rstrip()
    if len(prefix) >= len(_normalize_text(value)):
        prefix = _normalize_text(value)[: max(1, len(_normalize_text(value)) - 1)].rstrip()
    return f"{prefix}..." if prefix else ""


def _count_signal_presence(
    records: list[dict[str, Any]],
    field: str,
) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for record in records:
        for signal in record[field]:
            counts[signal] += 1
    return {key: counts[key] for key in _SIGNAL_ORDER if counts[key] > 0}


def _present_absent_counts(
    records: list[dict[str, Any]],
    signal: str,
) -> dict[str, int]:
    present = sum(1 for record in records if signal in record["signals"])
    return {"present": present, "absent": max(0, len(records) - present)}


def _preference_source_record_id(record: dict[str, Any], index: int) -> str:
    identity = record.get("jobIdentityAnchor") or {}
    value = (
        identity.get("jobId")
        or identity.get("encryptJobId")
        or record.get("conversationId")
        or f"rank-{index}"
    )
    return _safe_preference_text(value, 120) or f"rank-{index}"


def _parse_clarification_answers_artifact(
    value: PreferenceClarificationAnswersArtifact | dict[str, Any] | list[Any],
) -> PreferenceClarificationAnswersArtifact:
    if isinstance(value, PreferenceClarificationAnswersArtifact):
        return value
    if isinstance(value, list):
        raw_answers = value
    elif isinstance(value, dict) and isinstance(value.get("answers"), list):
        raw_answers = value.get("answers") or []
    elif isinstance(value, dict) and "answerId" in value:
        raw_answers = [value]
    else:
        raw_answers = []
    return PreferenceClarificationAnswersArtifact(
        answers=[
            _coerce_clarification_answer(item, index)
            for index, item in enumerate(raw_answers, start=1)
        ]
    )


def _normalize_clarification_answers(
    value: PreferenceClarificationAnswersArtifact | dict[str, Any] | None,
) -> list[PreferenceClarificationAnswer]:
    if value is None:
        return []
    artifact = _parse_clarification_answers_artifact(value)
    return sorted(
        artifact.answers,
        key=lambda answer: (answer.createdAt, answer.answerId),
    )


def _coerce_clarification_answer(
    value: Any,
    index: int,
) -> PreferenceClarificationAnswer:
    if isinstance(value, PreferenceClarificationAnswer):
        return value
    raw = value if isinstance(value, dict) else {}
    answer_id = _string(raw.get("answerId")) or f"answer-{index:03d}"
    affected_fields = raw.get("affectedFields")
    if not isinstance(affected_fields, list):
        affected_fields = []
    return build_preference_clarification_answer(
        answer_id=answer_id,
        question_text=_string(raw.get("questionText")) or "",
        recommended_answer_shown=_string(raw.get("recommendedAnswerShown")) or "",
        user_answer=_string(raw.get("userAnswer")) or "",
        affected_fields=[str(field) for field in affected_fields],
        created_at=_string(raw.get("createdAt")),
    )


def _format_clarification_answer_evidence(
    answer: PreferenceClarificationAnswer,
) -> str:
    affected = ", ".join(answer.affectedFields)
    return _clip(
        " | ".join(
            item
            for item in [
                f"Question: {answer.questionText}",
                f"Recommended: {answer.recommendedAnswerShown}",
                f"Answer: {answer.userAnswer}",
                f"Affects: {affected}" if affected else "",
            ]
            if item
        ),
        900,
    )


def _clarification_answers_fingerprint_payload(
    answers: list[PreferenceClarificationAnswer],
) -> dict[str, Any]:
    return {
        "schemaVersion": "preference-clarification-answers.v1",
        "answers": [
            answer.model_dump(exclude_none=True)
            for answer in sorted(answers, key=lambda item: item.answerId)
        ],
    }


def _combined_source_hash(source_fingerprints: dict[str, str]) -> str:
    payload = json.dumps(
        source_fingerprints,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _coerce_application_preference_profile(
    value: ApplicationPreferenceProfile | dict[str, Any] | Path | str,
) -> ApplicationPreferenceProfile:
    if isinstance(value, ApplicationPreferenceProfile):
        return value
    if isinstance(value, (Path, str)):
        return ApplicationPreferenceProfile.model_validate(
            json.loads(Path(value).read_text(encoding="utf-8"))
        )
    return ApplicationPreferenceProfile.model_validate(value)


def _coerce_preference_evidence_package(
    value: PreferenceEvidencePackage | dict[str, Any] | Path | str,
) -> PreferenceEvidencePackage:
    if isinstance(value, PreferenceEvidencePackage):
        return value
    if isinstance(value, (Path, str)):
        return PreferenceEvidencePackage.model_validate(
            json.loads(Path(value).read_text(encoding="utf-8"))
        )
    return PreferenceEvidencePackage.model_validate(value)


def _stable_identifier(value: Any, *, fallback_prefix: str) -> str:
    raw = _string(value) or ""
    normalized = re.sub(r"[^A-Za-z0-9_.-]+", "-", raw).strip("-_.")
    if normalized:
        return normalized[:80]
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]
    return f"{fallback_prefix}-{digest}"


def _safe_preference_text(value: Any, max_length: int) -> str:
    text = _string(value)
    return _clip(_redact_sensitive_fragments(text), max_length) if text else ""


def _source_sha256(artifact: dict[str, Any], source_bytes: bytes | None) -> str:
    if source_bytes is None:
        source_bytes = json.dumps(
            artifact,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    return hashlib.sha256(source_bytes).hexdigest()


def _iso_now(value: str | datetime | None) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, datetime):
        current = value
    else:
        current = datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return current.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _unique(values: list[str]) -> list[str]:
    output: list[str] = []
    seen: set[str] = set()
    for value in values:
        if value and value not in seen:
            output.append(value)
            seen.add(value)
    return output


def review_recent_application_preferences(
    *,
    db_path: Path | str | None = None,
    limit: int = 100,
) -> ApplicationPreferenceReview:
    path = Path(db_path) if db_path is not None else default_public_db_path()
    normalized_limit = max(1, min(int(limit or 100), 500))
    if not path.exists():
        return ApplicationPreferenceReview(
            ok=False,
            status="missing_db",
            dbPath=str(path),
            requestedLimit=normalized_limit,
            summary="No local application database was found.",
            warnings=["public_db_missing"],
        )

    try:
        rows = _fetch_recent_applications(path, normalized_limit)
    except sqlite3.DatabaseError as err:
        return ApplicationPreferenceReview(
            ok=False,
            status="schema_error",
            dbPath=str(path),
            requestedLimit=normalized_limit,
            summary="The local application database could not be read.",
            warnings=[f"sqlite_error:{_safe_warning(str(err))}"],
        )

    jobs = [_job_from_row(row) for row in rows]
    available_jd_count = sum(1 for job in jobs if job.jdOriginalCharacterCount > 0)
    warnings: list[str] = []
    if len(jobs) < normalized_limit:
        warnings.append("fewer_than_requested_recent_applications")
    if available_jd_count < len(jobs):
        warnings.append("some_recent_applications_missing_jd")

    top_title_terms = _top_terms(
        jobs,
        source=lambda job: " ".join(
            item
            for item in [job.title, job.positionName]
            if item
        ),
    )
    top_jd_terms = _top_terms(
        jobs,
        source=lambda job: " ".join(
            [job.jdSummary or "", *job.jdEvidenceSnippets]
        ),
    )

    return ApplicationPreferenceReview(
        ok=True,
        status="ready",
        dbPath=str(path),
        requestedLimit=normalized_limit,
        sampleSize=len(jobs),
        availableJdCount=available_jd_count,
        applicationSourceCounts=_counter_map(
            _application_source_label(job.chatStartupFrom) for job in jobs
        ),
        jobSourceCounts=_counter_map(_job_source_label(job.jobSource) for job in jobs),
        hireStatusCounts=_counter_map(_hire_status_label(job.hireStatus) for job in jobs),
        cityCounts=_counter_map(job.address or "unknown" for job in jobs),
        experienceCounts=_counter_map(job.experienceName or "unknown" for job in jobs),
        degreeCounts=_counter_map(job.degreeName or "unknown" for job in jobs),
        salaryBands=_counter_map(_salary_band(job) for job in jobs),
        topTitleTerms=top_title_terms,
        topJdTerms=top_jd_terms,
        jobs=jobs,
        warnings=warnings,
        summary=_build_summary(
            sample_size=len(jobs),
            available_jd_count=available_jd_count,
            title_terms=top_title_terms,
            jd_terms=top_jd_terms,
        ),
    )


def default_public_db_path() -> Path:
    return Path.home() / ".geekgeekrun" / "storage" / "public.db"


def _fetch_recent_applications(path: Path, limit: int) -> list[sqlite3.Row]:
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        return list(
            connection.execute(
                """
                SELECT
                  chat_startup_log.id AS applicationLogId,
                  chat_startup_log.date AS appliedAt,
                  chat_startup_log.encryptJobId AS jobId,
                  chat_startup_log.chatStartupFrom AS chatStartupFrom,
                  chat_startup_log.jobSource AS jobSource,
                  job_info.jobName AS title,
                  job_info.positionName AS positionName,
                  job_info.salaryLow AS salaryLow,
                  job_info.salaryHigh AS salaryHigh,
                  job_info.salaryMonth AS salaryMonth,
                  job_info.experienceName AS experienceName,
                  job_info.degreeName AS degreeName,
                  job_info.address AS address,
                  job_info.description AS description,
                  boss_info.title AS bossTitle,
                  company_info.name AS companyName,
                  job_hire_status_record.hireStatus AS hireStatus
                FROM chat_startup_log
                LEFT JOIN job_info
                  ON chat_startup_log.encryptJobId = job_info.encryptJobId
                LEFT JOIN boss_info
                  ON boss_info.encryptBossId = job_info.encryptBossId
                LEFT JOIN company_info
                  ON company_info.encryptCompanyId = job_info.encryptCompanyId
                LEFT JOIN job_hire_status_record
                  ON job_hire_status_record.encryptJobId = chat_startup_log.encryptJobId
                ORDER BY datetime(chat_startup_log.date) DESC, chat_startup_log.id DESC
                LIMIT ?
                """,
                (limit,),
            )
        )
    finally:
        connection.close()


def _job_from_row(row: sqlite3.Row) -> RecentAppliedJob:
    jd = str(row["description"] or "")
    jd_summary = _summarize_jd(jd)
    return RecentAppliedJob(
        applicationLogId=int(row["applicationLogId"]),
        appliedAt=_string(row["appliedAt"]),
        jobId=_string(row["jobId"]),
        title=_safe_text(row["title"], 120),
        positionName=_safe_text(row["positionName"], 120),
        companyName=_safe_text(row["companyName"], 120),
        bossTitle=_safe_text(row["bossTitle"], 80),
        address=_safe_text(row["address"], 120),
        salaryLow=_int_or_none(row["salaryLow"]),
        salaryHigh=_int_or_none(row["salaryHigh"]),
        salaryMonth=_int_or_none(row["salaryMonth"]),
        experienceName=_safe_text(row["experienceName"], 80),
        degreeName=_safe_text(row["degreeName"], 80),
        chatStartupFrom=_int_or_none(row["chatStartupFrom"]),
        jobSource=_int_or_none(row["jobSource"]),
        hireStatus=_int_or_none(row["hireStatus"]),
        jdSummary=jd_summary["summary"],
        jdEvidenceSnippets=jd_summary["evidenceSnippets"],
        jdOriginalCharacterCount=len(jd),
        jdOmittedCharacterCount=jd_summary["omittedCharacterCount"],
    )


def _summarize_jd(text: str) -> dict[str, Any]:
    redacted = _redact_sensitive_fragments(_normalize_text(text))
    summary = _clip(redacted, 240)
    snippets: list[str] = []
    seen: set[str] = set()
    segments = [
        _clip(segment, 160)
        for segment in re.split(r"[\r\n。；;，,.!！?？]+", redacted)
    ]
    prioritized = [segment for segment in segments if _looks_like_jd_evidence(segment)]
    for segment in [*prioritized, *segments]:
        key = segment.lower()
        if not segment or key in seen:
            continue
        seen.add(key)
        snippets.append(segment)
        if len(snippets) >= 3:
            break
    return {
        "summary": summary,
        "evidenceSnippets": snippets,
        "omittedCharacterCount": max(0, len(redacted) - len(summary)),
    }


def _top_terms(
    jobs: list[RecentAppliedJob],
    *,
    source,
    limit: int = 12,
) -> list[PreferenceTerm]:
    counts: Counter[str] = Counter()
    evidence: dict[str, list[str]] = {}
    for job in jobs:
        text = source(job)
        found = set(_extract_preference_terms(text))
        for term in found:
            counts[term] += 1
            if job.jobId:
                evidence.setdefault(term, [])
                if job.jobId not in evidence[term]:
                    evidence[term].append(job.jobId)
    return [
        PreferenceTerm(
            term=term,
            count=count,
            sampleJobIds=evidence.get(term, [])[:5],
        )
        for term, count in counts.most_common(limit)
    ]


_TERM_PATTERNS: tuple[tuple[str, str], ...] = (
    ("Python", r"\bpython\b|爬虫|自动化脚本"),
    ("Backend", r"后端|服务端|backend|server"),
    ("AI/LLM", r"\bai\b|人工智能|大模型|llm|agent|rag|生成式"),
    ("FastAPI", r"\bfastapi\b"),
    ("Flask", r"\bflask\b"),
    ("Django", r"\bdjango\b"),
    ("Node.js", r"\bnode(\.js)?\b|nestjs|express"),
    ("Frontend", r"前端|frontend|react|vue|typescript|javascript"),
    ("Data", r"数据分析|数据处理|data|etl|sql"),
    ("Crawler", r"爬虫|抓取|采集|spider|crawler"),
    ("Automation", r"自动化|workflow|流程|工具链"),
    ("Testing", r"测试|qa|自动化测试"),
    ("DevOps", r"devops|docker|k8s|kubernetes|ci/cd|运维"),
    ("Intern", r"实习|intern"),
    ("Remote", r"远程|remote"),
)


def _extract_preference_terms(text: str) -> list[str]:
    normalized = _normalize_text(text).lower()
    output: list[str] = []
    for label, pattern in _TERM_PATTERNS:
        if re.search(pattern, normalized, flags=re.IGNORECASE):
            output.append(label)
    return output


def _build_summary(
    *,
    sample_size: int,
    available_jd_count: int,
    title_terms: list[PreferenceTerm],
    jd_terms: list[PreferenceTerm],
) -> str:
    title = ", ".join(term.term for term in title_terms[:5]) or "no strong title terms"
    jd = ", ".join(term.term for term in jd_terms[:5]) or "no strong JD terms"
    return (
        f"Reviewed {sample_size} recent application records "
        f"({available_jd_count} with JD text). "
        f"Observed title preference terms: {title}. "
        f"Observed JD preference terms: {jd}. "
        "Use this as preference evidence only; it does not grant Application Authorization."
    )


def _counter_map(values) -> dict[str, int]:
    return dict(Counter(value for value in values if value).most_common(12))


def _application_source_label(value: int | None) -> str:
    return {
        1: "manual_from_recommend_list",
        None: "auto_from_recommend_list",
    }.get(value, f"source_{value}")


def _job_source_label(value: int | None) -> str:
    return {
        1: "expect",
        2: "recommend",
        3: "search",
        None: "unknown",
    }.get(value, f"job_source_{value}")


def _hire_status_label(value: int | None) -> str:
    return {
        1: "hiring",
        2: "closed",
        3: "deleted",
        None: "unknown",
    }.get(value, f"hire_status_{value}")


def _salary_band(job: RecentAppliedJob) -> str:
    low = job.salaryLow
    high = job.salaryHigh
    if low is None and high is None:
        return "unknown"
    if high is not None and high < 15:
        return "below_15k"
    if low is not None and low >= 30:
        return "30k_plus"
    if high is not None and high <= 25:
        return "15k_to_25k"
    return "25k_to_35k"


def _looks_like_jd_evidence(value: str) -> bool:
    return bool(
        re.search(
            r"responsibilit|requirement|qualification|任职|岗位|职位|职责|要求|负责|熟悉|掌握|具备|优先|加分|经验|技术栈|开发|维护|搭建",
            value,
            flags=re.IGNORECASE,
        )
    )


def _redact_sensitive_fragments(value: str) -> str:
    redacted = re.sub(
        r"[?&]securityId=[^&#\s]+",
        "[REDACTED_BROWSER_PARAM]",
        value,
        flags=re.IGNORECASE,
    )
    redacted = re.sub(
        r"\bsecurityId\s*[:=]\s*[^\s,;，；。]+",
        "[REDACTED_BROWSER_PARAM]",
        redacted,
        flags=re.IGNORECASE,
    )
    redacted = re.sub(
        r"\b(cookie|cookies|localStorage|local_storage|apiKey|api_key|browserUrl|cdpPort)\s*[:=]\s*[^\s,;，；。]+",
        "[REDACTED_SECRET]",
        redacted,
        flags=re.IGNORECASE,
    )
    redacted = re.sub(r"CANARY_[A-Z0-9_]+", "[REDACTED]", redacted)
    redacted = re.sub(r"\b[A-Za-z]:[\\/][^\s,;，；。]+", "[REDACTED_PATH]", redacted)
    redacted = re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[REDACTED_EMAIL]", redacted)
    redacted = re.sub(r"\b(sk|pk)-[A-Za-z0-9_-]{12,}\b", "[REDACTED_SECRET]", redacted)
    return redacted


def _safe_warning(value: str) -> str:
    return _clip(_redact_sensitive_fragments(value), 160)


def _safe_text(value: Any, max_length: int) -> str | None:
    text = _string(value)
    return _clip(_redact_sensitive_fragments(text), max_length) if text else None


def _string(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _normalize_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").replace("\r\n", "\n")).strip()


def _clip(value: str, max_length: int) -> str:
    normalized = _normalize_text(value)
    if len(normalized) <= max_length:
        return normalized
    return f"{normalized[: max(0, max_length - 3)].rstrip()}..."


def _int_or_none(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
