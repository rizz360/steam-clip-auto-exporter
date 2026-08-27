import * as path from "@std/path";
import config from "./config.ts";

import {
  fileExists,
  sanitizeFileName,
  writeCorrectedMpdFile,
} from "./fileUtilities.ts";

const clipNameRegex = /clip_\d+_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/;
const clipDestinationPattern = "$1-$2-$3 $4-$5-$6";

// ISteamApps/GetAppList (the old bulk endpoint) was deprecated by Valve, so
// app names are now resolved one appid at a time via the Store API and cached.
const appNameCache = new Map<string, string>();

async function getAppName(appId: string): Promise<string> {
  const cached = appNameCache.get(appId);
  if (cached !== undefined) return cached;

  let name = `Unknown App ${appId}`;
  try {
    const res = await fetch(
      `https://store.steampowered.com/api/appdetails?appids=${appId}&filters=basic`,
    );
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok || !contentType.includes("application/json")) {
      throw new Error(
        `Steam Store API returned ${res.status} ${res.statusText} (${contentType})`,
      );
    }
    const data = await res.json();
    const entry = data[appId];
    if (entry?.success && entry.data?.name) {
      name = entry.data.name;
    } else {
      console.warn(`No app name found for appid ${appId}, using fallback.`);
    }
  } catch (err) {
    console.warn(`Failed to fetch app name for appid ${appId}:`, err);
  }

  appNameCache.set(appId, name);
  return name;
}

function parseClipDate(clipName: string): Date | null {
  const match = clipNameRegex.exec(clipName);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  // Clip filenames encode local wall-clock time, no timezone info.
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
}

async function runFfmpeg(
  inputFile: string,
  outputFile: string,
): Promise<void> {
  const command = new Deno.Command("ffmpeg", {
    args: ["-i", inputFile, "-c", "copy", outputFile],
    stdout: "null",
    stderr: "piped",
  });
  const { code, stderr } = await command.output();
  if (code !== 0) {
    throw new Error(
      `ffmpeg exited with code ${code}: ${new TextDecoder().decode(stderr)}`,
    );
  }
}

// Sets the exported file's modified/accessed time (all platforms) and, on
// Windows, its creation time too, to match when the clip was actually
// recorded rather than when it was exported.
async function applyClipTimestamp(
  outputFile: string,
  clipDate: Date,
): Promise<void> {
  try {
    await Deno.utime(outputFile, clipDate, clipDate);
    if (Deno.build.os === "windows") {
      const command = new Deno.Command("powershell", {
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "(Get-Item -LiteralPath $env:CLIP_OUTPUT_FILE).CreationTimeUtc = " +
          "[datetime]$env:CLIP_DATE",
        ],
        env: {
          CLIP_OUTPUT_FILE: outputFile,
          CLIP_DATE: clipDate.toISOString(),
        },
        stdout: "null",
        stderr: "piped",
      });
      const { code, stderr } = await command.output();
      if (code !== 0) {
        throw new Error(
          `powershell exited with code ${code}: ${
            new TextDecoder().decode(stderr)
          }`,
        );
      }
    }
  } catch (err) {
    console.warn(`Failed to set clip date on ${outputFile}:`, err);
  }
}

export async function exportAll() {
  for (const clipsPath of config.clipPaths) {
    for (const clipWrapperPath of Deno.readDirSync(clipsPath)) {
      await exportSingleEntry(clipsPath, clipWrapperPath.name);
    }
  }
}

export async function exportSingleEntry(
  clipParentFolder: string,
  clipName: string,
) {
  const videoPath = path.join(clipParentFolder, clipName, "video");
  for (const clipPath of Deno.readDirSync(videoPath)) {
    const inputDirectory = path.join(videoPath, clipPath.name);

    const appName = sanitizeFileName(
      await getAppName(clipPath.name.split("_")[1]),
    );
    const outputFileName = clipName.replace(
      clipNameRegex,
      `${appName} ${clipDestinationPattern}.mp4`,
    );
    const outputDir = config.groupClipsByGame
      ? path.join(config.outputPath, appName)
      : config.outputPath;
    const outputFile = path.join(outputDir, outputFileName);
    const clipDate = parseClipDate(clipName);
    if (await fileExists(outputFile)) {
      console.log(`Skipping ${inputDirectory}. Already exported`);
      if (clipDate) await applyClipTimestamp(outputFile, clipDate);
      continue;
    }
    const inputFile = await writeCorrectedMpdFile(inputDirectory);

    console.log(`Exporting ${inputDirectory} to ${outputFile}`);

    await Deno.mkdir(outputDir, { recursive: true });
    await runFfmpeg(inputFile, outputFile);
    if (clipDate) await applyClipTimestamp(outputFile, clipDate);
    return;
  }
}
