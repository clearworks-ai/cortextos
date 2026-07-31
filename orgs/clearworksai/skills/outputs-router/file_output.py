import argparse
import os
import shutil
import sys
from datetime import datetime

# Define the base directory for knowledge-sync
KNOWLEDGE_SYNC_BASE = os.path.expanduser("~/code/knowledge-sync/")

# Define the mapping from content type to destination directory
CONTENT_TYPE_MAPPING = {
    "client": os.path.join(KNOWLEDGE_SYNC_BASE, "raw/areas/clearworks/"),
    "people": os.path.join(KNOWLEDGE_SYNC_BASE, "raw/resources/people/"),
    "org": os.path.join(KNOWLEDGE_SYNC_BASE, "raw/resources/organizations/"),
    "sop": os.path.join(KNOWLEDGE_SYNC_BASE, "raw/resources/reference/clearworks/"),
    "diagram": os.path.join(KNOWLEDGE_SYNC_BASE, "raw/areas/clearworks/diagrams/"),
    "session": os.path.join(KNOWLEDGE_SYNC_BASE, "raw/sessions/"),
    "media": os.path.join(KNOWLEDGE_SYNC_BASE, "raw/media/"),
}


def parse_arguments():
    parser = argparse.ArgumentParser(
        description="Deterministic filing helper for knowledge-sync artifacts."
    )
    parser.add_argument(
        "--content-type",
        required=True,
        choices=CONTENT_TYPE_MAPPING.keys(),
        help="The type of content being filed.",
    )
    parser.add_argument(
        "--source", required=True, help="The path to the source file."
    )
    parser.add_argument(
        "--agent", required=True, help="The name of the agent filing the artifact."
    )
    parser.add_argument(
        "--job", required=True, help="The job name associated with the artifact."
    )
    parser.add_argument(
        "--source-task", required=True, help="The ID of the source task."
    )
    parser.add_argument(
        "--date", required=True, help="The ISO date of the artifact."
    )
    parser.add_argument(
        "--client", help="The client slug (required for 'client' content type)."
    )
    return parser.parse_args()


def validate_arguments(args):
    if args.content_type == "client" and not args.client:
        print("Error: --client missing when --content-type=client", file=sys.stderr)
        sys.exit(1)

    if not os.path.exists(args.source):
        print(f"Error: Source path '{args.source}' does not exist", file=sys.stderr)
        sys.exit(1)


def get_destination_path(args):
    base_dest = CONTENT_TYPE_MAPPING[args.content_type]
    if args.content_type == "client":
        dest_dir = os.path.join(base_dest, args.client)
    else:
        dest_dir = base_dest

    filename = os.path.basename(args.source)
    return os.path.join(dest_dir, filename)


def inject_frontmatter(file_path, args):
    frontmatter = f"""---
agent: {args.agent}
job: {args.job}
source-task: {args.source_task}
date: {args.date}
---
"""
    with open(file_path, "r+") as f:
        content = f.read()
        f.seek(0, 0)
        f.write(frontmatter + content)


def create_provenance_sidecar(file_path, args):
    provenance_path = f"{file_path}.provenance.md"
    frontmatter = f"""---
agent: {args.agent}
job: {args.job}
source-task: {args.source_task}
date: {args.date}
---
"""
    with open(provenance_path, "w") as f:
        f.write(frontmatter)


def main():
    args = parse_arguments()
    validate_arguments(args)

    dest_path = get_destination_path(args)
    dest_dir = os.path.dirname(dest_path)

    if os.path.exists(dest_path):
        print(f"Error: Destination file '{dest_path}' already exists", file=sys.stderr)
        sys.exit(1)

    os.makedirs(dest_dir, exist_ok=True)
    shutil.copy2(args.source, dest_path)

    file_ext = os.path.splitext(dest_path)[1].lower()
    if file_ext in [".md", ".txt"]:
        inject_frontmatter(dest_path, args)
    else:
        create_provenance_sidecar(dest_path, args)

    print(dest_path)


if __name__ == "__main__":
    main()