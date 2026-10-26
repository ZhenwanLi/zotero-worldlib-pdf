#!/usr/bin/env python3
"""Build a deterministic XPI from an explicit runtime-file allowlist."""
import hashlib
import json
from pathlib import Path
import re
import zipfile


def main():
    root = Path(__file__).resolve().parent.parent
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise SystemExit("Expected a three-component numeric version")
    files = [root / "bootstrap.js", root / "manifest.json"]
    for folder in ("src", "chrome"):
        files.extend(sorted((root / folder).rglob("*")))
    files = [p for p in files if p.is_file()]
    allowed = {".js", ".json", ".css", ".xhtml", ".svg", ".png"}
    for path in files:
        if path.is_symlink() or path.suffix not in allowed or any(
            part.startswith(".") for part in path.relative_to(root).parts
        ):
            raise SystemExit("Unexpected runtime file: " + str(path.relative_to(root)))
    output = root / "dist" / ("worldlib-pdf-" + version + ".xpi")
    checksum = output.with_suffix(".xpi.sha256")
    if output.exists() or checksum.exists():
        raise SystemExit("Build output already exists; refusing to overwrite")
    output.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(files):
            entry = zipfile.ZipInfo(path.relative_to(root).as_posix(), (2020, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, path.read_bytes())
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    with checksum.open("x", encoding="utf-8") as stream:
        stream.write(digest + "  " + output.name + "\n")
    print("Built " + output.relative_to(root).as_posix())
    print("SHA-256: " + digest)


if __name__ == "__main__":
    main()
