#!/usr/bin/env python3
"""Check the checked-in Claude plugin and its scenario/eval inputs."""

import json
import argparse
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins/radius"


def load_json(path):
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def version_tuple(version):
    assert re.fullmatch(r"\d+\.\d+\.\d+", version), f"invalid plugin version: {version}"
    return tuple(int(part) for part in version.split("."))


def check_release_version(base_ref, current_version):
    base = git("merge-base", base_ref, "HEAD").decode().strip()
    changed = git("diff", "--name-only", "-z", f"{base}..HEAD", "--", "plugins/radius/")
    paths = [path.decode() for path in changed.split(b"\0") if path]
    release_content_changed = any(
        path.startswith("plugins/radius/skills/")
        or path == "plugins/radius/.claude-plugin/plugin.json"
        or path == "plugins/radius/README.md"
        for path in paths
    )
    if not release_content_changed:
        return
    previous = json.loads(git("show", f"{base}:plugins/radius/.claude-plugin/plugin.json"))
    old_version = previous["version"]
    assert version_tuple(current_version) > version_tuple(old_version), (
        f"plugin release content changed without a version bump: "
        f"{old_version} -> {current_version}"
    )


def check_changelog(current_version):
    # The docs release notes are built from this file, so every released version needs an entry.
    changelog = PLUGIN / "CHANGELOG.md"
    assert changelog.is_file(), "plugin CHANGELOG.md missing"
    content = changelog.read_text(encoding="utf-8")
    entries = re.findall(r"^## (\S+) \((\d{4}-\d{2}-\d{2})\)$", content, re.MULTILINE)
    headings = re.findall(r"^## .*$", content, re.MULTILINE)
    assert len(entries) == len(headings), "plugin CHANGELOG.md headings must read `## <version> (<YYYY-MM-DD>)`"
    versions = [version_tuple(version) for version, _ in entries]
    assert versions == sorted(set(versions), reverse=True), "plugin CHANGELOG.md versions must be unique, newest first"
    dates = [date for _, date in entries]
    assert dates == sorted(dates, reverse=True), "plugin CHANGELOG.md dates must be newest first"
    assert current_version in [version for version, _ in entries], (
        f"plugin {current_version} has no entry in plugins/radius/CHANGELOG.md"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-ref", help="require a plugin version bump for release content changed since this ref")
    args = parser.parse_args()
    marketplace = load_json(ROOT / ".claude-plugin/marketplace.json")
    manifest = load_json(PLUGIN / ".claude-plugin/plugin.json")
    entries = marketplace["plugins"]
    assert marketplace["name"] == "tools", "the public marketplace identity is tools"
    assert manifest["name"] == "radius", "the public plugin identity is radius"
    assert len(entries) == 1
    assert entries[0]["source"] == "./plugins/radius"
    assert entries[0]["name"] == manifest["name"]
    assert "version" not in entries[0], "plugin.json is the single plugin version source"
    version_tuple(manifest["version"])
    assert (PLUGIN / "README.md").is_file(), "plugin README missing"
    assert manifest["license"] == "MIT"
    check_changelog(manifest["version"])
    if args.base_ref:
        check_release_version(args.base_ref, manifest["version"])

    skills = sorted((PLUGIN / "skills").glob("*/SKILL.md"))
    assert skills, "no skills found"
    fixtures = 0
    for skill in skills:
        content = skill.read_text(encoding="utf-8")
        assert content.startswith("---\n"), f"missing frontmatter: {skill}"
        frontmatter = content.split("---", 2)[1]
        assert f"name: {skill.parent.name}" in frontmatter, f"name mismatch: {skill}"
        assert "description:" in frontmatter, f"missing description: {skill}"
        # Claude interpolates $0, $1, etc. when a skill is invoked with arguments,
        # including inside code fences. Currency and shell examples must stay literal.
        assert not re.search(r"\$\d+(?!\w)", content), (
            f"unintended positional argument placeholder in {skill}: "
            "use decimal USD strings and named shell variables in skill entrypoints"
        )
        for target in re.findall(r"\]\(([^)#]+)(?:#[^)]*)?\)", content):
            if "://" not in target and not target.startswith("#"):
                assert (skill.parent / target).exists(), f"broken link {target} in {skill}"
        for path in (skill.parent / "evaluations").glob("*.json"):
            scenario = load_json(path)
            assert scenario.get("query") and (
                scenario.get("success_criteria") or scenario.get("expected_behavior")
            ), path
            assert skill.parent.name in scenario.get("skills", []), path
            fixtures += 1

    cases = sorted((PLUGIN / "evals").glob("*/prompt.md"))
    assert cases, "no Claude plugin eval cases found"
    for prompt in cases:
        assert prompt.read_text(encoding="utf-8").startswith("---\n"), prompt
        assert list((prompt.parent / "graders").glob("*.md")), prompt

    print(f"Validated {len(skills)} skills, {fixtures} scenario fixtures, {len(cases)} Claude eval cases")


if __name__ == "__main__":
    main()
