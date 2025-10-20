#!/usr/bin/env python3
import json
import sys

def main() -> int:
    payload = sys.stdin.read().strip()
    if not payload:
        sys.stderr.write(json.dumps({"error": "no payload"}) + "\n")
        return 1
    try:
        json.loads(payload)
    except json.JSONDecodeError as exc:
        sys.stderr.write(json.dumps({"error": str(exc)}) + "\n")
        return 1
    sys.stdout.write(json.dumps({"prediction": 1, "probability": 0.92}))
    return 0

if __name__ == "__main__":
    sys.exit(main())
