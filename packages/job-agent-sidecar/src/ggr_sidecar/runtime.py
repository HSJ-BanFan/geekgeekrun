from __future__ import annotations

import hashlib
import json
import os
import tomllib
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Mapping

try:
    from ggr_sidecar_build_version import DISTRIBUTION_VERSION as FROZEN_DISTRIBUTION_VERSION
except ImportError:
    FROZEN_DISTRIBUTION_VERSION = None

INSTALLATION_MANIFEST_SCHEMA = "job-agent-installation-manifest.v1"
EXPECTED_CONTRACTS = {
    "cli": "job-agent-cli.v1",
    "installationManifest": INSTALLATION_MANIFEST_SCHEMA,
    "marketJobs": "market-jobs.v1",
    "marketJobsAnalysis": "market-jobs-analysis.v1",
}
BUILD_FEATURES = {
    "nodeCli": True,
    "sidecar": True,
    "openaiAgentsSdk": False,
}


@dataclass(frozen=True)
class CliRuntime:
    mode: str
    node_runtime: str
    cli_path: Path
    cwd: Path
    install_manifest_path: Path | None = None


class RuntimeDiscoveryError(RuntimeError):
    def __init__(self, reason_code: str, message: str) -> None:
        super().__init__(message)
        self.reason_code = reason_code


def resolve_cli_runtime(
    *,
    repo_root: Path | str | None = None,
    node: str | None = None,
    env: Mapping[str, str] | None = None,
    cwd: Path | str | None = None,
) -> CliRuntime:
    runtime_env = os.environ if env is None else env
    caller_cwd = Path.cwd() if cwd is None else Path(cwd)
    if runtime_env.get("GGR_JOB_AGENT_MODE") == "installed":
        if repo_root is not None or node is not None:
            raise RuntimeDiscoveryError(
                "DEVELOPMENT_RUNTIME_OVERRIDE_NOT_ALLOWED",
                "--repo-root and --node are available only in source-development mode",
            )
        manifest_path, manifest = load_installation_manifest(runtime_env)
        install_root = manifest_path.parent
        node_runtime = resolve_manifest_component(
            install_root,
            manifest,
            "nodeRuntime",
        )
        cli_path = resolve_manifest_component(install_root, manifest, "nodeCli")
        return CliRuntime(
            mode="installed",
            node_runtime=str(node_runtime),
            cli_path=cli_path,
            cwd=caller_cwd.resolve(),
            install_manifest_path=manifest_path,
        )

    root = Path(repo_root) if repo_root is not None else _default_repo_root()
    return CliRuntime(
        mode="source",
        node_runtime=node or "node",
        cli_path=root / "packages" / "job-agent-cli" / "bin" / "ggr.mjs",
        cwd=root,
    )


def build_version_report(
    *,
    env: Mapping[str, str] | None = None,
) -> dict:
    runtime_env = os.environ if env is None else env
    runtime_mode = (
        "installed"
        if runtime_env.get("GGR_JOB_AGENT_MODE") == "installed"
        else "source"
    )
    if runtime_mode == "installed":
        _, manifest = load_installation_manifest(runtime_env)
        distribution_version = manifest["distributionVersion"]
        contracts = manifest["contracts"]
        features = manifest["features"]
    else:
        distribution_version = sidecar_version()
        contracts = EXPECTED_CONTRACTS
        features = BUILD_FEATURES
    return {
        "ok": True,
        "command": "version",
        "schemaVersion": "job-agent-sidecar-version.v1",
        "distribution": {
            "name": "geekgeekrun-job-agent",
            "version": distribution_version,
            "channel": "prerelease",
        },
        "contracts": contracts,
        "features": features,
        "runtimeMode": runtime_mode,
        "reasonCode": None,
    }


def load_installation_manifest(
    env: Mapping[str, str],
) -> tuple[Path, dict]:
    configured_path = env.get("GGR_JOB_AGENT_INSTALL_MANIFEST", "").strip()
    if not configured_path:
        raise RuntimeDiscoveryError(
            "INSTALL_MANIFEST_NOT_FOUND",
            "GGR_JOB_AGENT_INSTALL_MANIFEST is required in installed mode",
        )
    manifest_path = Path(configured_path).resolve()
    if not manifest_path.is_file():
        raise RuntimeDiscoveryError(
            "INSTALL_MANIFEST_NOT_FOUND",
            f"Installation manifest not found: {manifest_path}",
        )
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeDiscoveryError(
            "INSTALL_MANIFEST_INVALID",
            f"Installation manifest is not valid JSON: {error}",
        ) from error
    if not isinstance(manifest, dict):
        raise RuntimeDiscoveryError(
            "INSTALL_MANIFEST_INVALID",
            "Installation manifest must be a JSON object",
        )
    if manifest.get("schemaVersion") != INSTALLATION_MANIFEST_SCHEMA:
        raise RuntimeDiscoveryError(
            "INSTALL_MANIFEST_SCHEMA_UNSUPPORTED",
            "Installation manifest schema is unsupported",
        )
    if manifest.get("distributionVersion") != sidecar_version():
        raise RuntimeDiscoveryError(
            "DISTRIBUTION_VERSION_MISMATCH",
            "Sidecar and installation manifest versions do not match",
        )
    if not _contains_expected_values(manifest.get("contracts"), EXPECTED_CONTRACTS):
        raise RuntimeDiscoveryError(
            "CONTRACT_VERSION_MISMATCH",
            "Installation manifest contract versions do not match the sidecar build",
        )
    if not _contains_expected_values(manifest.get("features"), BUILD_FEATURES):
        raise RuntimeDiscoveryError(
            "DISTRIBUTION_FEATURE_MISMATCH",
            "Installation manifest features do not match the sidecar build",
        )
    if not isinstance(manifest.get("components"), dict):
        raise RuntimeDiscoveryError(
            "INSTALL_MANIFEST_INVALID",
            "Installation manifest components must be a JSON object",
        )
    return manifest_path, manifest


def resolve_manifest_component(
    install_root: Path,
    manifest: dict,
    component_name: str,
) -> Path:
    component = manifest["components"].get(component_name)
    if not isinstance(component, dict):
        raise RuntimeDiscoveryError(
            "COMPONENT_NOT_DECLARED",
            f"Installation component is not declared: {component_name}",
        )
    relative_path = component.get("path")
    expected_hash = component.get("sha256")
    if not isinstance(relative_path, str) or not relative_path.strip():
        raise RuntimeDiscoveryError(
            "COMPONENT_METADATA_INVALID",
            f"Installation component path is invalid: {component_name}",
        )
    if not isinstance(expected_hash, str) or not expected_hash.strip():
        raise RuntimeDiscoveryError(
            "COMPONENT_METADATA_INVALID",
            f"Installation component hash is invalid: {component_name}",
        )
    declared_path = Path(relative_path)
    if declared_path.is_absolute():
        raise RuntimeDiscoveryError(
            "COMPONENT_PATH_OUTSIDE_INSTALLATION",
            f"Installation component path must be relative: {component_name}",
        )
    resolved_root = install_root.resolve()
    resolved_path = (resolved_root / declared_path).resolve()
    try:
        resolved_path.relative_to(resolved_root)
    except ValueError as error:
        raise RuntimeDiscoveryError(
            "COMPONENT_PATH_OUTSIDE_INSTALLATION",
            f"Installation component escapes the installation root: {component_name}",
        ) from error
    if not resolved_path.is_file():
        raise RuntimeDiscoveryError(
            "COMPONENT_FILE_MISSING",
            f"Installation component file is missing: {component_name}",
        )
    actual_hash = hashlib.sha256(resolved_path.read_bytes()).hexdigest()
    if actual_hash != expected_hash.strip().lower():
        raise RuntimeDiscoveryError(
            "COMPONENT_HASH_MISMATCH",
            f"Installation component hash does not match: {component_name}",
        )
    return resolved_path


def sidecar_version() -> str:
    try:
        return version("geekgeekrun-job-agent-sidecar")
    except PackageNotFoundError:
        return FROZEN_DISTRIBUTION_VERSION or _source_distribution_version()


def runtime_temp_root(
    *,
    env: Mapping[str, str] | None = None,
) -> Path | None:
    runtime_env = os.environ if env is None else env
    if runtime_env.get("GGR_JOB_AGENT_MODE") != "installed":
        return None
    configured_home = runtime_env.get("GGR_JOB_AGENT_HOME", "").strip()
    runtime_home = Path(configured_home) if configured_home else Path.home() / ".geekgeekrun-job-agent"
    return runtime_home / "temp"


def _source_distribution_version() -> str:
    pyproject_path = Path(__file__).resolve().parents[2] / "pyproject.toml"
    try:
        pyproject = tomllib.loads(pyproject_path.read_text(encoding="utf-8"))
        source_version = pyproject.get("project", {}).get("version")
        return source_version if isinstance(source_version, str) else "0+unknown"
    except (OSError, tomllib.TOMLDecodeError):
        return "0+unknown"


def _contains_expected_values(actual, expected: dict) -> bool:
    return isinstance(actual, dict) and all(
        actual.get(name) == value for name, value in expected.items()
    )


def _default_repo_root() -> Path:
    return Path(__file__).resolve().parents[4]
