# Test Agent Memory Index

## ROUTING
- [Railway alerts route to larry](topic_a.md) — route all Railway/deploy/CI failures to larry; Josh sees diagnosis + fix only
- [Briefs go to the website](topic_b.md) — publish via publish-brief.py and send only the feed URL, never raw Telegram text
- [This entry is far too long and should trip the max-entry-chars lint rule because it rambles on and on about routing conventions, dedup keys, receipt lines, verification steps, and various other operational details that belong in the topic file instead of the one-line index](topic_a.md) — an overlong summary that pushes this single line well past the two-hundred-character budget enforced by lintMemoryIndex
- [Phantom claim with no topic file](topic_missing.md) — points at a topic file that was never written and has no KB backing

## NOTES
Non-entry lines like this one are ignored by the parser.
