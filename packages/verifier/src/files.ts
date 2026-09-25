/**
 * Writes a set of files into a sandbox as a single shell command. Base64+shell,
 * not `tar`, and not the `InstanceSpawnRequest.files` field the API reference
 * mentions — that field's shape was never verified live and command/stdout is
 * the one I/O path confirmed working end-to-end (see docs/DECISIONS.md).
 * Base64's alphabet has no shell metacharacters, so each blob is safe inside
 * single quotes with no escaping logic needed.
 */

export type FileSet = Record<string, string>

export function buildWriteFilesCommand(files: FileSet): string {
  const steps = Object.entries(files).map(([path, content]) => {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "."
    const base64 = Buffer.from(content, "utf8").toString("base64")
    return `mkdir -p "${dir}" && echo '${base64}' | base64 -d > "${path}"`
  })
  return steps.join(" && ")
}

/** Prefixes every key in a FileSet with a directory — e.g. harness.ts's output into "harness/". */
export function prefixFiles(files: FileSet, dir: string): FileSet {
  const out: FileSet = {}
  for (const [path, content] of Object.entries(files)) {
    out[`${dir}/${path}`] = content
  }
  return out
}
