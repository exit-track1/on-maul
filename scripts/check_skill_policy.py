"""Verify this project's official Codex skill allowlist and preserved files."""

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def require(condition, message):
    if not condition:
        raise SystemExit(f"Skill policy failed: {message}")


def file_hashes(folder):
    require(folder.is_dir(), f"missing folder: {folder.relative_to(ROOT)}")
    return {
        str(file.relative_to(folder)): hashlib.sha256(file.read_bytes()).hexdigest()
        for file in folder.rglob("*")
        if file.is_file() and file.name != ".DS_Store"
    }


def main():
    downloads = ROOT / ".skill-downloads"
    policy = json.loads((downloads / "codex-policy.json").read_text())
    manifest_bytes = (downloads / "download-manifest.json").read_bytes()
    require(
        hashlib.sha256(manifest_bytes).hexdigest() == policy["manifestSha256"],
        "manifest changed without an approved policy update",
    )
    manifest = json.loads(manifest_bytes)
    require(
        policy["allowedRepository"] == "https://github.com/openai/skills",
        "only the official Codex skills source is permitted",
    )
    active = ROOT / ".agents" / "skills"
    actual_active = sorted(p.name for p in active.iterdir() if p.is_dir())
    require(actual_active == sorted(policy["activeSkills"]), "unapproved active skill")
    actual_archives = sorted(
        str(f.parent.relative_to(ROOT))
        for f in (downloads / "upstream").rglob("SKILL.md")
    )
    entries = manifest["retainedSkills"]
    require(
        sorted(e["installationName"] for e in entries) == sorted(policy["archivedSkills"]),
        "archive inventory differs from the allowlist",
    )
    require(
        actual_archives == sorted(e["archivePath"] for e in entries),
        "unapproved archived skill",
    )
    expected_upstream_files = set()
    for entry in entries:
        require(entry["repositoryUrl"] == policy["allowedRepository"], "invalid source")
        require(entry["commit"] == policy["allowedCommit"], "invalid pinned commit")
        for key in ["archivePath", "activeInstallPath"]:
            if not entry[key]:
                continue
            path = ROOT / entry[key]
            require(path.resolve().is_relative_to(ROOT), "path outside the project")
            require(
                file_hashes(path) == entry["fileSha256"],
                f"unapproved or modified files in {entry[key]}",
            )
        for relative_path in entry["fileSha256"]:
            expected_upstream_files.add(entry["archivePath"] + "/" + relative_path)
    actual_upstream_files = {
        str(f.relative_to(ROOT))
        for f in (downloads / "upstream").rglob("*")
        if f.is_file() and f.name != ".DS_Store"
    }
    require(actual_upstream_files == expected_upstream_files, "unapproved upstream file")
    print(f"Codex skill policy passed: {len(actual_active)} active, {len(entries)} archived.")


if __name__ == "__main__":
    main()
