"""
Utility script to clean up OHLCV cache files after training.

Usage:
    python cleanup_cache.py              # Clean all cache files
    python cleanup_cache.py --keep-days 7  # Keep files from last 7 days
    python cleanup_cache.py --dry-run    # Show what would be deleted
"""
from __future__ import annotations

import argparse
import os
import shutil
from datetime import datetime, timedelta
from pathlib import Path


CACHE_DIR = Path(__file__).resolve().parents[1] / "data" / "ccxt_cache"


def cleanup_cache(keep_days: int | None = None, dry_run: bool = False) -> dict:
    """
    Clean up cache directory.
    
    Args:
        keep_days: If provided, only delete files older than this many days
        dry_run: If True, show what would be deleted without actually deleting
        
    Returns:
        Dictionary with cleanup statistics
    """
    if not CACHE_DIR.exists():
        return {
            "status": "no_cache_dir",
            "deleted_files": 0,
            "deleted_bytes": 0,
            "message": f"Cache directory does not exist: {CACHE_DIR}"
        }
    
    deleted_files = 0
    deleted_bytes = 0
    kept_files = 0
    
    cutoff_time = None
    if keep_days is not None:
        cutoff_time = datetime.now().timestamp() - (keep_days * 24 * 60 * 60)
    
    # List all CSV files in cache directory
    csv_files = list(CACHE_DIR.glob("*.csv"))
    
    for file_path in csv_files:
        try:
            file_stat = file_path.stat()
            file_size = file_stat.st_size
            file_mtime = file_stat.st_mtime
            
            # Check if file should be deleted
            should_delete = True
            if cutoff_time is not None and file_mtime > cutoff_time:
                should_delete = False
            
            if should_delete:
                if dry_run:
                    print(f"Would delete: {file_path.name} ({file_size:,} bytes)")
                else:
                    file_path.unlink()
                    print(f"Deleted: {file_path.name} ({file_size:,} bytes)")
                deleted_files += 1
                deleted_bytes += file_size
            else:
                kept_files += 1
                if dry_run:
                    print(f"Would keep: {file_path.name} (modified recently)")
                    
        except Exception as e:
            print(f"Error processing {file_path.name}: {e}")
    
    return {
        "status": "success",
        "deleted_files": deleted_files,
        "deleted_bytes": deleted_bytes,
        "deleted_mb": round(deleted_bytes / (1024 * 1024), 2),
        "kept_files": kept_files,
        "dry_run": dry_run,
        "keep_days": keep_days,
    }


def cleanup_all_cache(dry_run: bool = False) -> dict:
    """Remove entire cache directory."""
    if not CACHE_DIR.exists():
        return {
            "status": "no_cache_dir",
            "message": f"Cache directory does not exist: {CACHE_DIR}"
        }
    
    if dry_run:
        size = sum(f.stat().st_size for f in CACHE_DIR.glob("*.csv"))
        count = len(list(CACHE_DIR.glob("*.csv")))
        return {
            "status": "dry_run",
            "would_delete_files": count,
            "would_delete_bytes": size,
            "would_delete_mb": round(size / (1024 * 1024), 2),
        }
    
    try:
        shutil.rmtree(CACHE_DIR)
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        return {
            "status": "success",
            "message": "Cache directory completely cleared"
        }
    except Exception as e:
        return {
            "status": "error",
            "message": str(e)
        }


def main():
    parser = argparse.ArgumentParser(
        description="Clean up OHLCV cache files",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--keep-days",
        type=int,
        help="Keep files modified within the last N days (default: delete all)"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be deleted without actually deleting"
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Remove entire cache directory"
    )
    
    args = parser.parse_args()
    
    print(f"Cache directory: {CACHE_DIR}")
    print("-" * 60)
    
    if args.all:
        result = cleanup_all_cache(dry_run=args.dry_run)
    else:
        result = cleanup_cache(keep_days=args.keep_days, dry_run=args.dry_run)
    
    print("-" * 60)
    print(f"Status: {result['status']}")
    
    if result['status'] == 'success':
        if 'deleted_files' in result:
            print(f"Deleted files: {result['deleted_files']}")
            print(f"Space freed: {result['deleted_mb']} MB")
            if result.get('kept_files', 0) > 0:
                print(f"Kept files: {result['kept_files']}")
        if result.get('dry_run'):
            print("\n⚠️  DRY RUN - No files were actually deleted")
    elif result['status'] == 'no_cache_dir':
        print(result['message'])
    
    return 0 if result['status'] == 'success' else 1


if __name__ == "__main__":
    exit(main())
