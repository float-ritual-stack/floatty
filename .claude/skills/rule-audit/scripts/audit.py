#!/usr/bin/env python3
"""Audit .claude/rules/ for broken citations.

Walks every rule file, extracts cited file paths, checks them against the
filesystem, and reports drift. Stdlib only, no dependencies.

Usage: python3 .claude/skills/rule-audit/scripts/audit.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# Backtick-wrapped paths that look like file references.
# Matches: `foo.ts`, `src/foo.ts`, `apps/floatty/src/foo.ts:123`, `foo.ts:10-50`
FILE_PATH_PATTERN = re.compile(
    r'`([a-zA-Z0-9_./\-]+\.[a-zA-Z]{1,6}(?::\d+(?:-\d+)?)?)`'
)

# File extensions we consider "real" code/doc files worth verifying.
REAL_EXTENSIONS = {
    '.md', '.mdx', '.rs', '.ts', '.tsx', '.js', '.jsx', '.json',
    '.py', '.sh', '.toml', '.yaml', '.yml', '.css', '.html',
}

# Obvious noise patterns that match the path regex but are not real citations.
NOISE_PATTERNS = [
    re.compile(r'^(foo|bar|baz|example|mytype)(\.|/)'),
    re.compile(r'^path/to/'),
    re.compile(r'node_modules/'),
    re.compile(r'\*'),  # globs
]

# Candidate project roots under which to resolve citations.
# The first match wins when a citation could resolve under multiple roots.
PROJECT_SUBTREES = [
    Path('apps/floatty'),
    Path('.'),
]


def find_project_root() -> Path | None:
    """Walk up from cwd looking for a .claude/rules/ directory."""
    current = Path.cwd().resolve()
    for parent in [current] + list(current.parents):
        if (parent / '.claude' / 'rules').is_dir():
            return parent
    return None


def find_rule_files(project_root: Path) -> list[Path]:
    rules_dir = project_root / '.claude' / 'rules'
    if not rules_dir.exists():
        return []
    return sorted(rules_dir.glob('*.md'))


def strip_frontmatter(content: str) -> str:
    """Remove YAML frontmatter so we do not audit frontmatter paths as body citations."""
    if content.startswith('---\n'):
        end = content.find('\n---\n', 4)
        if end != -1:
            return content[end + 5:]
    return content


def extract_file_citations(content: str) -> set[str]:
    """Extract backtick-wrapped paths that look like file references."""
    body = strip_frontmatter(content)

    # Drop code fences — their contents are examples, not citations.
    # This is a heuristic: we remove anything between ``` markers.
    body = re.sub(r'```[\s\S]*?```', '', body)

    citations: set[str] = set()
    for match in FILE_PATH_PATTERN.finditer(body):
        path = match.group(1)

        # Skip noise
        if any(p.search(path) for p in NOISE_PATTERNS):
            continue

        # Strip line number to check extension
        file_part = path.split(':', 1)[0]
        ext_idx = file_part.rfind('.')
        if ext_idx == -1:
            continue
        ext = file_part[ext_idx:].lower()
        if ext not in REAL_EXTENSIONS:
            continue

        citations.add(path)

    return citations


def strip_line_number(path: str) -> tuple[str, int | None, int | None]:
    """Split `file.ts:123` or `file.ts:123-145` into (file, start, end)."""
    match = re.match(r'^(.+?):(\d+)(?:-(\d+))?$', path)
    if match:
        file = match.group(1)
        start = int(match.group(2))
        end = int(match.group(3)) if match.group(3) else None
        return file, start, end
    return path, None, None


def resolve_citation(project_root: Path, file_part: str) -> Path | None:
    """Try to find the file in any of the candidate subtrees."""
    for subtree in PROJECT_SUBTREES:
        candidate = project_root / subtree / file_part
        if candidate.exists() and candidate.is_file():
            return candidate
    # Also try interpreting the path as project-root-relative
    direct = project_root / file_part
    if direct.exists() and direct.is_file():
        return direct
    return None


def find_near_matches(project_root: Path, file_part: str) -> list[Path]:
    """Search for files with the same basename, for 'did you mean' suggestions."""
    basename = Path(file_part).name
    if not basename:
        return []
    matches: list[Path] = []
    try:
        for subtree in PROJECT_SUBTREES:
            search_root = project_root / subtree
            if not search_root.is_dir():
                continue
            for match in search_root.rglob(basename):
                if match.is_file() and '.git' not in match.parts and 'node_modules' not in match.parts:
                    matches.append(match)
                    if len(matches) >= 5:
                        return matches
    except (OSError, PermissionError):
        pass
    return matches


def verify_citation(project_root: Path, citation: str) -> tuple[str, str]:
    """Return (status, detail) where status is 'ok', 'near_match', 'missing', 'drift', 'partial'.

    Status meanings:
    - 'ok': file exists at the exact cited path
    - 'near_match': file exists but at a different path than cited (bare-basename citation)
    - 'missing': no file with that name found anywhere
    - 'drift': file exists but cited line number exceeds file length
    - 'partial': file exists but could not be read
    """
    file_part, start, end = strip_line_number(citation)
    resolved = resolve_citation(project_root, file_part)

    # If the literal path doesn't resolve, try a near-match search by basename.
    if resolved is None:
        matches = find_near_matches(project_root, file_part)
        if matches:
            rel_matches = [str(m.relative_to(project_root)) for m in matches[:3]]
            # One unambiguous match → near-match (warning, not error)
            if len(matches) == 1:
                return ('near_match', f'cited as `{file_part}` but actual path is `{rel_matches[0]}`')
            # Multiple matches → ambiguous (warning, not error)
            return ('near_match', f'cited as `{file_part}` but ambiguous — matches: ' + ', '.join(f'`{m}`' for m in rel_matches))
        return ('missing', f'no file found matching `{file_part}`')

    if start is not None:
        try:
            with resolved.open(encoding='utf-8', errors='replace') as f:
                line_count = sum(1 for _ in f)
        except (OSError, UnicodeDecodeError):
            return ('partial', 'exists but unreadable')
        if start > line_count:
            return ('drift', f'cites line {start} but `{resolved.relative_to(project_root)}` has only {line_count} lines')
        if end is not None and end > line_count:
            return ('drift', f'cites line range ending at {end} but file has {line_count} lines')

    return ('ok', '')


def audit_rule_file(project_root: Path, rule_file: Path) -> dict:
    """Audit a single rule file. Returns a report dict."""
    try:
        content = rule_file.read_text(encoding='utf-8', errors='replace')
    except OSError as e:
        return {
            'file': rule_file,
            'read_error': str(e),
            'citation_count': 0,
            'verified': [],
            'missing': [],
            'drift': [],
            'partial': [],
        }

    citations = extract_file_citations(content)

    report: dict = {
        'file': rule_file,
        'citation_count': len(citations),
        'verified': [],
        'near_match': [],
        'missing': [],
        'drift': [],
        'partial': [],
    }

    for citation in sorted(citations):
        status, detail = verify_citation(project_root, citation)
        entry = (citation, detail)
        key = status if status != 'ok' else 'verified'
        report[key].append(entry)

    return report


def format_report(reports: list[dict], verbose: bool = False) -> str:
    """Format audit reports as markdown. verbose=True includes near-match details per file."""
    lines: list[str] = ['# Rule File Audit Report', '']
    lines.append(f'Audited {len(reports)} rule files.')
    lines.append('')

    total_cites = sum(r['citation_count'] for r in reports)
    total_missing = sum(len(r['missing']) for r in reports)
    total_drift = sum(len(r['drift']) for r in reports)
    total_near = sum(len(r['near_match']) for r in reports)
    total_partial = sum(len(r['partial']) for r in reports)

    lines.append(f'- **Total citations**: {total_cites}')
    lines.append(f'- **Missing files (error)**: {total_missing}')
    lines.append(f'- **Line-number drift (error)**: {total_drift}')
    lines.append(f'- **Near-match (warning)**: {total_near}')
    lines.append(f'- **Partial / unreadable**: {total_partial}')
    lines.append('')

    if total_near > 0 and not verbose:
        lines.append('*Near-match warnings are bare-basename citations that resolve to a real file at a qualified path. These do not fail CI but indicate the citation should be updated to use the full path. Run with `--verbose` to see details.*')
        lines.append('')

    any_errors = False
    for report in reports:
        errors = report['missing'] or report['drift'] or report['partial']
        warnings = report['near_match']

        if not errors and not (verbose and warnings):
            continue

        if errors:
            any_errors = True

        rel_path = report['file'].name
        lines.append(f'## {rel_path}')
        lines.append('')
        lines.append(
            f'{report["citation_count"]} citations; '
            f'{len(report["missing"])} missing, '
            f'{len(report["drift"])} drift, '
            f'{len(report["near_match"])} near-match, '
            f'{len(report["partial"])} partial'
        )
        lines.append('')

        if report['missing']:
            lines.append('### ❌ Missing (error)')
            for citation, detail in report['missing']:
                lines.append(f'- `{citation}` — {detail}')
            lines.append('')

        if report['drift']:
            lines.append('### ⚠️ Line drift (error)')
            for citation, detail in report['drift']:
                lines.append(f'- `{citation}` — {detail}')
            lines.append('')

        if verbose and report['near_match']:
            lines.append('### 🔸 Near-match (warning — bare basename, should use qualified path)')
            for citation, detail in report['near_match']:
                lines.append(f'- `{citation}` — {detail}')
            lines.append('')

        if report['partial']:
            lines.append('### 🔸 Partial')
            for citation, detail in report['partial']:
                lines.append(f'- `{citation}` — {detail}')
            lines.append('')

    if not any_errors:
        lines.append('All citations verified (no errors). ✅')

    return '\n'.join(lines)


def main() -> int:
    verbose = '--verbose' in sys.argv or '-v' in sys.argv

    project_root = find_project_root()
    if project_root is None:
        print('Error: could not find .claude/rules/ in current directory or ancestors', file=sys.stderr)
        return 1

    rule_files = find_rule_files(project_root)
    if not rule_files:
        print('No rule files found in .claude/rules/', file=sys.stderr)
        return 0

    reports = [audit_rule_file(project_root, rf) for rf in rule_files]
    print(format_report(reports, verbose=verbose))

    # Exit non-zero only on true errors (missing, drift), not near-matches.
    has_errors = any(r['missing'] or r['drift'] for r in reports)
    return 1 if has_errors else 0


if __name__ == '__main__':
    sys.exit(main())
