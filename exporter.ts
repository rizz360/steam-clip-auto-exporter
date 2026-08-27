import * as path from "@std/path";
import { exec } from "node:child_process";
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
    const outputFile = path.join(config.outputPath, outputFileName);
    if (await fileExists(outputFile)) {
      console.log(`Skipping ${inputDirectory}. Already exported`);
      continue;
    }
    const inputFile = await writeCorrectedMpdFile(inputDirectory);

    console.log(`Exporting ${inputDirectory} to ${outputFile}`);

    await exec(
      `ffmpeg -i "${inputFile}" -c copy "${outputFile}"`,
    );
    return;
  }
}
