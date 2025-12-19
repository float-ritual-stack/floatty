#!/usr/bin/env python3
"""
Test different Ollama models for ctx:: marker extraction.
Run standalone - no Tauri app needed.

Usage:
    python tools/test_ctx_models.py
    python tools/test_ctx_models.py --models qwen3:4b qwen2.5:7b-instruct
"""

import json
import time
import urllib.request
import argparse
from typing import Optional

OLLAMA_ENDPOINT = "http://float-box:11434"

# Sample ctx:: content (typical from JSONL)
SAMPLE_CTX_LINES = [
    # Simple ctx:: marker
    """Starting investigation on pharmacy issue 120.
- ctx::2025-12-15 @ 10:30 AM [project::pharmacy] [issue::120] beginning fresh investigation
Will check the GP node rendering first.""",

    # More complex with mode
    """Switching to config refactoring for float-pty.
- ctx::2025-12-18 @ 09:12 PM [project::float-pty] [mode::config-refactor] implemented config-driven max_age_hours via ~/.floatty/config.toml
This should make the time window adjustable without code changes.""",

    # Meeting context
    """Meeting with team about Q1 priorities.
- ctx::2025-12-18 @ 02:00 PM [project::rangle] [meeting::sprint-planning] discussed pharmacy release timeline
Action items captured in daily note.""",
]

SYSTEM_PROMPT = """You extract structured data from text containing ctx:: markers.

A ctx:: marker looks like:
ctx::YYYY-MM-DD @ HH:MM AM/PM [tag::value] [tag::value] optional message

Common tags: project::, mode::, issue::, meeting::

Extract the marker fields AND summarize the surrounding context."""

EXAMPLE_INPUT = """EXAMPLE INPUT:
Starting investigation on pharmacy issue 120.
- ctx::2025-12-15 @ 10:30 AM [project::pharmacy] [issue::120] beginning fresh investigation
Will check the GP node rendering first.

EXAMPLE OUTPUT:
{"timestamp":"2025-12-15","time":"10:30 AM","project":"pharmacy","issue":"120","summary":"Starting investigation on pharmacy issue 120, planning to check GP node rendering","message":"beginning fresh investigation"}

---
NOW PARSE THIS:

"""

# JSON schema for structured output
FORMAT_SCHEMA = {
    "type": "object",
    "properties": {
        "timestamp": {"type": "string"},
        "time": {"type": "string"},
        "project": {"type": "string"},
        "mode": {"type": "string"},
        "meeting": {"type": "string"},
        "issue": {"type": "string"},
        "summary": {"type": "string"},
        "message": {"type": "string"},
    },
    "required": ["timestamp", "time", "summary"]
}


def query_ollama(model: str, prompt: str, timeout: int = 60) -> tuple[Optional[dict], float]:
    """Query Ollama and return (parsed_result, elapsed_seconds)."""

    request_data = {
        "model": model,
        "prompt": f"{EXAMPLE_INPUT}{prompt}",
        "system": SYSTEM_PROMPT,
        "stream": False,
        "format": FORMAT_SCHEMA,
    }

    data = json.dumps(request_data).encode('utf-8')
    req = urllib.request.Request(
        f"{OLLAMA_ENDPOINT}/api/generate",
        data,
        headers={'Content-Type': 'application/json'}
    )

    start = time.time()
    try:
        response = urllib.request.urlopen(req, timeout=timeout)
        result = json.loads(response.read())
        elapsed = time.time() - start

        # Parse the response JSON
        response_text = result.get('response', '{}')
        parsed = json.loads(response_text)
        return parsed, elapsed

    except Exception as e:
        elapsed = time.time() - start
        print(f"  ERROR: {e}")
        return None, elapsed


def test_model(model: str, samples: list[str]) -> dict:
    """Test a model on all samples, return stats."""

    print(f"\n{'='*60}")
    print(f"Testing: {model}")
    print('='*60)

    results = []

    for i, sample in enumerate(samples):
        print(f"\n  Sample {i+1}:")
        parsed, elapsed = query_ollama(model, sample)

        if parsed:
            print(f"    Time: {elapsed:.2f}s")
            print(f"    Result: {json.dumps(parsed, indent=6)[:200]}...")
            results.append({
                'success': True,
                'elapsed': elapsed,
                'parsed': parsed,
                'has_timestamp': bool(parsed.get('timestamp')),
                'has_project': bool(parsed.get('project')),
                'has_summary': bool(parsed.get('summary')),
            })
        else:
            results.append({
                'success': False,
                'elapsed': elapsed,
            })

    # Compute stats
    successes = [r for r in results if r['success']]
    avg_time = sum(r['elapsed'] for r in successes) / len(successes) if successes else 0
    success_rate = len(successes) / len(results) * 100

    print(f"\n  Summary for {model}:")
    print(f"    Success rate: {success_rate:.0f}% ({len(successes)}/{len(results)})")
    print(f"    Avg time: {avg_time:.2f}s")

    return {
        'model': model,
        'success_rate': success_rate,
        'avg_time': avg_time,
        'results': results,
    }


def main():
    parser = argparse.ArgumentParser(description='Test Ollama models for ctx:: extraction')
    parser.add_argument('--models', nargs='+',
                        default=['qwen3:4b', 'qwen2.5:7b-instruct', 'qwen2.5:1.5b'],
                        help='Models to test')
    parser.add_argument('--samples', type=int, default=None,
                        help='Number of samples to test (default: all)')
    args = parser.parse_args()

    samples = SAMPLE_CTX_LINES[:args.samples] if args.samples else SAMPLE_CTX_LINES

    print(f"Testing {len(args.models)} models on {len(samples)} samples")
    print(f"Endpoint: {OLLAMA_ENDPOINT}")

    all_results = []
    for model in args.models:
        result = test_model(model, samples)
        all_results.append(result)

    # Final comparison
    print("\n" + "="*60)
    print("COMPARISON")
    print("="*60)
    print(f"{'Model':<25} {'Success':<10} {'Avg Time':<10}")
    print("-"*45)
    for r in sorted(all_results, key=lambda x: x['avg_time']):
        print(f"{r['model']:<25} {r['success_rate']:.0f}%{'':<6} {r['avg_time']:.2f}s")


if __name__ == '__main__':
    main()
