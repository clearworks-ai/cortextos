from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("upsert-engagement.py")


class UpsertEngagementTests(unittest.TestCase):
    def test_next_action_updates_selected_engagement(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pipeline_path = Path(tmp) / "pipeline.json"
            pipeline_path.write_text(
                json.dumps(
                    {
                        "engagements": [
                            {
                                "record_id": "legacy:engagement:gbk-collective-busywork-audit",
                                "name": "GBK Collective Busywork Audit",
                                "clearpath_id": None,
                                "stage": "proposal_sent",
                                "next_action": "send proposal",
                            }
                        ]
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            env = os.environ.copy()
            env["CRM_PIPELINE_PATH"] = str(pipeline_path)

            result = subprocess.run(
                [
                    "python3",
                    str(SCRIPT_PATH),
                    "--engagement-name",
                    "GBK Collective Busywork Audit",
                    "--next-action",
                    "close decision loop",
                ],
                capture_output=True,
                text=True,
                env=env,
                cwd=str(SCRIPT_PATH.parent),
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            engagement = json.loads(pipeline_path.read_text())["engagements"][0]
            self.assertEqual(engagement["next_action"], "close decision loop")


if __name__ == "__main__":
    unittest.main()
