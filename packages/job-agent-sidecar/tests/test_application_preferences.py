from __future__ import annotations

import sqlite3
from pathlib import Path

from ggr_sidecar.application_preferences import (
    default_public_db_path,
    review_recent_application_preferences,
)


def test_review_recent_application_preferences_reads_recent_jobs_and_jd_signals(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "public.db"
    create_db(db_path)
    insert_job(
        db_path,
        job_id="job-old",
        date="2026-07-01T10:00:00.000Z",
        title="运营助理",
        description="负责内容整理。",
    )
    insert_job(
        db_path,
        job_id="job-python",
        date="2026-07-05T10:00:00.000Z",
        title="Python AI 后端开发",
        description=(
            "负责 FastAPI 服务开发、LLM Agent 工具接入和自动化工作流建设。"
            "CANARY_FULL_JOB_DESCRIPTION C:\\Users\\Meiosis\\secret\\resume.png"
        ),
        address="上海",
        salary_low=20,
        salary_high=30,
        experience="1-3年",
        degree="本科",
        company_name="Example Co",
        boss_title="Tech Lead",
        job_source=3,
        hire_status=1,
    )
    insert_job(
        db_path,
        job_id="job-data",
        date="2026-07-04T10:00:00.000Z",
        title="Python 数据处理工程师",
        description="负责 Python 数据处理、SQL ETL 和自动化流程。",
        address="上海",
        salary_low=15,
        salary_high=22,
    )

    review = review_recent_application_preferences(db_path=db_path, limit=2)
    serialized = review.model_dump_json()

    assert review.ok is True
    assert review.status == "ready"
    assert review.sampleSize == 2
    assert review.availableJdCount == 2
    assert [job.jobId for job in review.jobs] == ["job-python", "job-data"]
    assert review.cityCounts["上海"] == 2
    assert review.salaryBands["15k_to_25k"] == 1
    assert review.salaryBands["25k_to_35k"] == 1
    assert any(term.term == "Python" for term in review.topTitleTerms)
    assert any(term.term == "AI/LLM" for term in review.topJdTerms)
    assert review.preferenceEvidenceUse == "decision_evidence_only_not_application_authorization"
    assert "CANARY_FULL_JOB_DESCRIPTION" not in serialized
    assert "C:\\Users\\Meiosis\\secret" not in serialized


def test_review_recent_application_preferences_reports_missing_db(tmp_path: Path) -> None:
    review = review_recent_application_preferences(
        db_path=tmp_path / "missing.db",
        limit=100,
    )

    assert review.ok is False
    assert review.status == "missing_db"
    assert "public_db_missing" in review.warnings
    assert review.sampleSize == 0


def test_installed_default_public_db_path_uses_the_isolated_runtime_home(
    tmp_path: Path,
    monkeypatch,
) -> None:
    runtime_home = tmp_path / "job-agent-home"
    monkeypatch.setenv("GGR_JOB_AGENT_MODE", "installed")
    monkeypatch.setenv("GGR_JOB_AGENT_HOME", str(runtime_home))

    assert default_public_db_path() == runtime_home / "data" / "public.db"


def create_db(path: Path) -> None:
    with sqlite3.connect(path) as connection:
        connection.executescript(
            """
            CREATE TABLE chat_startup_log (
              id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
              encryptJobId varchar NOT NULL,
              encryptCurrentUserId varchar NOT NULL,
              date datetime NOT NULL,
              chatStartupFrom integer,
              autoStartupChatRecordId integer,
              jobSource integer
            );
            CREATE TABLE job_info (
              encryptJobId varchar PRIMARY KEY NOT NULL,
              jobName varchar NOT NULL,
              positionName varchar NOT NULL,
              salaryLow integer,
              salaryHigh integer,
              salaryMonth integer,
              experienceName varchar NOT NULL,
              publishDate datetime,
              degreeName varchar,
              address varchar,
              description varchar NOT NULL,
              encryptBossId varchar NOT NULL,
              encryptCompanyId varchar NOT NULL
            );
            CREATE TABLE boss_info (
              encryptBossId varchar PRIMARY KEY NOT NULL,
              encryptCompanyId varchar,
              name varchar NOT NULL,
              date datetime NOT NULL,
              title varchar NOT NULL
            );
            CREATE TABLE company_info (
              encryptCompanyId varchar PRIMARY KEY NOT NULL,
              name varchar NOT NULL,
              brandName varchar NOT NULL,
              scaleLow integer,
              scaleHigh integer,
              stageName varchar,
              industryName varchar
            );
            CREATE TABLE job_hire_status_record (
              encryptJobId varchar PRIMARY KEY NOT NULL,
              hireStatus integer NOT NULL,
              lastSeenDate datetime NOT NULL
            );
            """
        )


def insert_job(
    path: Path,
    *,
    job_id: str,
    date: str,
    title: str,
    description: str,
    address: str = "未知",
    salary_low: int | None = None,
    salary_high: int | None = None,
    experience: str = "不限",
    degree: str = "不限",
    company_name: str = "Unknown Co",
    boss_title: str = "Boss",
    job_source: int | None = None,
    hire_status: int | None = None,
) -> None:
    boss_id = f"boss-{job_id}"
    company_id = f"company-{job_id}"
    with sqlite3.connect(path) as connection:
        connection.execute(
            """
            INSERT INTO chat_startup_log (
              encryptJobId,
              encryptCurrentUserId,
              date,
              chatStartupFrom,
              jobSource
            )
            VALUES (?, 'user-1', ?, NULL, ?)
            """,
            (job_id, date, job_source),
        )
        connection.execute(
            """
            INSERT INTO job_info (
              encryptJobId,
              jobName,
              positionName,
              salaryLow,
              salaryHigh,
              salaryMonth,
              experienceName,
              degreeName,
              address,
              description,
              encryptBossId,
              encryptCompanyId
            )
            VALUES (?, ?, ?, ?, ?, 12, ?, ?, ?, ?, ?, ?)
            """,
            (
                job_id,
                title,
                title,
                salary_low,
                salary_high,
                experience,
                degree,
                address,
                description,
                boss_id,
                company_id,
            ),
        )
        connection.execute(
            """
            INSERT INTO boss_info (encryptBossId, encryptCompanyId, name, date, title)
            VALUES (?, ?, 'Hiring Manager', ?, ?)
            """,
            (boss_id, company_id, date, boss_title),
        )
        connection.execute(
            """
            INSERT INTO company_info (encryptCompanyId, name, brandName)
            VALUES (?, ?, ?)
            """,
            (company_id, company_name, company_name),
        )
        if hire_status is not None:
            connection.execute(
                """
                INSERT INTO job_hire_status_record (encryptJobId, hireStatus, lastSeenDate)
                VALUES (?, ?, ?)
                """,
                (job_id, hire_status, date),
            )
