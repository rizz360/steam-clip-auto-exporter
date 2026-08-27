import * as path from "@std/path";
import { MpdFile } from "./interfaces.ts";
import { parse, stringify } from "@libs/xml";

// Steam app names can contain characters that are illegal in Windows
// filenames (e.g. "RV There Yet?", "Clair Obscur: Expedition 33"). Strip
// reserved characters and trailing dots/spaces before using a name as a
// path segment.
const invalidFileNameCharsRegex = /[<>:"/\\|?*\x00-\x1F]/g;

export function sanitizeFileName(name: string): string {
  return name.replace(invalidFileNameCharsRegex, "").replace(/[\s.]+$/, "");
}

export async function fileExists(path: string | null): Promise<boolean> {
  if (path === null) return false;
  try {
    await Deno.lstat(path);
    return true;
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw err;
    }
    return false;
  }
}

export async function writeCorrectedMpdFile(
  clipDirectory: string,
): Promise<string> {
  const targetPath = path.join(clipDirectory, "session.corrected.mpd");
  if (await fileExists(targetPath)) return targetPath;
  const dom = parse(
    await Deno.open(path.join(clipDirectory, "session.mpd")),
  ) as MpdFile;
  dom.MPD.Period["@start"] = "PT0.0S";
  await Deno.writeTextFile(targetPath, stringify(dom));
  return targetPath;
}
