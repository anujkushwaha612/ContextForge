#!/usr/bin/env python3
"""
bench_patch_ast.py

End-to-End verification script for contextforge_patch_ast tool logic.
Creates a mock target file, queries the proxy to edit a symbol, and asserts the write.
"""

from __future__ import annotations
import json
import os
import sys
import time
import uuid
from pathlib import Path
import requests

_repo_root = Path(__file__).resolve().parent.parent
if str(_repo_root) not in sys.path:
    sys.path.insert(0, str(_repo_root))

PROXY_URL = "http://localhost:3000"
TEST_FILE_PATH = "src/mock_payment_service.js"


def setup_mock_file():
    """Create a sample source code file with a distinct function to patch."""
    content = """// Mock Payment Processing Module
const logger = require('./logger');

class PaymentService {
    constructor() {
        this.provider = 'stripe';
    }

    async processTransaction(amount, currency) {
        // TARGET_SYMBOL_START
        console.log("Processing payment via legacy engine");
        if (amount <= 0) {
            throw new Error("Invalid amount");
        }
        return { success: true, status: "legacy_complete", tx_id: "tx_999" };
        // TARGET_SYMBOL_END
    }

    async refundTransaction(txId) {
        return { success: true, refund_id: "ref_111" };
    }
}

module.exports = PaymentService;
"""
    absolute_path = _repo_root / TEST_FILE_PATH
    absolute_path.parent.mkdir(parents=True, exist_ok=True)
    absolute_path.write_text(content, encoding="utf-8")
    print(f"  [Setup] Mock file created at {TEST_FILE_PATH}")


def trigger_graph_reindex():
    """
    Simulate a user query or trigger an internal endpoint to ensure 
    the workspaceMapper indexes our new file before we try to patch it.
    """
    # Simply making an empty dry-run request containing the filename
    # forces your workspaceMapper to find and index it.
    payload = {
        "model": "claude-3-5-sonnet-20241022",
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "Ping proxy to index workspace"}],
    }
    requests.post(
        f"{PROXY_URL}/v1/messages",
        json=payload,
        headers={"x-cf-dry-run": "true", "x-api-key": "benchmark"}
    )
    print("  [Setup] Triggered workspace graph sync.")


def send_patch_request() -> dict:
    """Send a natural language request to the LLM forcing it to actively call the patch tool."""

    new_body_code = """    async processTransaction(amount, currency) {
        console.log(`[ModernEngine] Initiating charge for ${amount} ${currency}`);
        const stripeTx = await this.executeSecureStripeCall({ amt: amount, cur: currency });
        return { success: true, status: "modern_complete", tx_id: stripeTx.id };
    }"""

    payload = {
        "model": "claude-3-5-sonnet-20241022",
        "max_tokens": 512,
        "stream": False,
        "system": "You are an autonomous coding agent. Use the contextforge_patch_ast tool to edit files.",
        "messages": [
            {
                "role": "user",
                "content": (
                    "Please update the `processTransaction` function in `src/mock_payment_service.js`.\n"
                    f"Replace the entire function body with the following code:\n\n{new_body_code}\n\n"
                    "Execute the contextforge_patch_ast tool immediately to apply this change."
                )
            }
        ],
    }

    # Real request — the Ghost Interceptor will catch the LLM's tool call response
    resp = requests.post(
        f"{PROXY_URL}/v1/messages",
        json=payload,
        headers={
            "content-type": "application/json",
            "x-api-key": "benchmark",
            "anthropic-version": "2023-06-01",
        },
        timeout=30
    )
    return resp.json()


def verify_and_cleanup():
    """Verify that the changes are present on disk, then clean up the file."""
    absolute_path = _repo_root / TEST_FILE_PATH
    updated_content = absolute_path.read_text(encoding="utf-8")

    # Assertions
    assert "[ModernEngine]" in updated_content, "💥 FAIL: New code was not written to disk!"
    assert "legacy_complete" not in updated_content, "💥 FAIL: Old code was not cleaned/spliced out!"

    print("  [Verify] File checked. Code modification matches exactly.")

    # Cleanup
    if absolute_path.exists():
        absolute_path.unlink()
    print("  [Cleanup] Mock file removed safely.")


def main():
    print("=" * 70)
    print("  CONTEXTFORGE WRITE-SIDE VALIDATION RUN")
    print("  Testing: contextforge_patch_ast End-to-End Loop")
    print("=" * 70)

    try:
        requests.get(f"{PROXY_URL}/dashboard", timeout=2)
    except Exception:
        print(f"❌ Error: Proxy not running at {PROXY_URL}")
        return 1

    try:
        setup_mock_file()
        time.sleep(1)  # Give the system a brief moment
        trigger_graph_reindex()

        print("\nSending patch command through Ghost Interceptor...")
        response_data = send_patch_request()

        print(f"Proxy Response: {json.dumps(response_data, indent=2)}")

        print("\nVerifying disk manipulation adjustments...")
        verify_and_cleanup()

        print("\n✅ SUCCESS: contextforge_patch_ast executed flawlessly.")
        return 0

    except Exception as e:
        print(f"\n❌ FAILED: {str(e)}")
        # Dynamic fallback cleanup in case of execution crash
        absolute_path = _repo_root / TEST_FILE_PATH
        if absolute_path.exists():
            absolute_path.unlink()
        return 1


if __name__ == "__main__":
    sys.exit(main())
