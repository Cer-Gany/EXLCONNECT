import { createLogger } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const maxDuration = 300;

const log = createLogger("api/session/upload");
const MAX_RECORDING_SIZE = 200 * 1024 * 1024;

function isValidSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isValidFilename(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 180 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) &&
    !value.includes("..")
  );
}

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file");
    const sessionId = formData.get("sessionId");
    const type = formData.get("type");
    const requestedFilename = formData.get("filename");

    if (
      !(file instanceof Blob) ||
      typeof sessionId !== "string" ||
      typeof type !== "string"
    ) {
      return NextResponse.json(
        { error: "Missing required fields: file, sessionId, type" },
        { status: 400 },
      );
    }

    if (!isValidSessionId(sessionId)) {
      return NextResponse.json({ error: "Invalid session ID" }, { status: 400 });
    }

    if (type !== "recording" && type !== "screenshot") {
      return NextResponse.json(
        { error: 'type must be "recording" or "screenshot"' },
        { status: 400 },
      );
    }

    if (file.size === 0) {
      return NextResponse.json({ error: "The uploaded file is empty" }, { status: 400 });
    }

    const isLocalRecording =
      type === "recording" &&
      (process.env.RECORDING_STORAGE ?? "supabase").toLowerCase() === "local";

    if (type === "recording" && file.size > MAX_RECORDING_SIZE) {
      return NextResponse.json(
        { error: "Recording exceeds the 200 MB local upload limit" },
        { status: 413 },
      );
    }

    const { data: session, error: sessionError } = await supabaseAdmin
      .from("sessions")
      .select("id")
      .eq("id", sessionId)
      .maybeSingle();

    if (sessionError) {
      log.error("Failed to verify upload session:", sessionError);
      return NextResponse.json({ error: "Could not verify interview session" }, { status: 500 });
    }

    if (!session) {
      return NextResponse.json({ error: "Interview session not found" }, { status: 404 });
    }

    const defaultExt =
      type === "screenshot"
        ? "jpg"
        : file.type?.includes("mp4") || file.type?.includes("m4a")
          ? "m4a"
          : "webm";

    const filename =
      typeof requestedFilename === "string" && requestedFilename.length > 0
        ? requestedFilename
        : `${Date.now()}.${defaultExt}`;

    if (!isValidFilename(filename)) {
      return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
    }

    if (isLocalRecording) {
      const root = path.resolve(
        /*turbopackIgnore: true*/
        process.env.LOCAL_RECORDINGS_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), "recordings"),
      );
      const sessionDirectory = path.resolve(/*turbopackIgnore: true*/ root, sessionId);

      if (!sessionDirectory.startsWith(`${root}${path.sep}`)) {
        return NextResponse.json({ error: "Invalid recording path" }, { status: 400 });
      }

      await mkdir(/*turbopackIgnore: true*/ sessionDirectory, { recursive: true });

      const destination = path.join(/*turbopackIgnore: true*/ sessionDirectory, filename);
      const buffer = Buffer.from(await file.arrayBuffer());

      // wx prevents accidentally overwriting an existing recording.
      await writeFile(/*turbopackIgnore: true*/ destination, buffer, { flag: "wx" });

      const url = `/api/session/local-recording?sessionId=${encodeURIComponent(sessionId)}&filename=${encodeURIComponent(filename)}`;

      log.info(`Saved local recording ${sessionId}/${filename} (${file.size} bytes)`);

      return NextResponse.json({
        url,
        path: `${sessionId}/${filename}`,
        bucket: "local",
      });
    }

    const bucket = type === "recording" ? "recordings" : "screenshots";
    const storagePath = `${sessionId}/${filename}`;
    const buffer = Buffer.from(await file.arrayBuffer());

    const defaultContentType =
      type === "screenshot"
        ? "image/jpeg"
        : file.type?.startsWith("video/")
          ? file.type
          : file.type?.includes("mp4")
            ? "audio/mp4"
            : "audio/webm";

    const { error: uploadError } = await supabaseAdmin.storage
      .from(bucket)
      .upload(storagePath, buffer, {
        contentType: file.type || defaultContentType,
        upsert: false,
      });

    if (uploadError) {
      log.error("Storage error:", bucket, uploadError);
      return NextResponse.json({ error: uploadError.message }, { status: 500 });
    }

    const { data: signedData, error: signedError } = await supabaseAdmin.storage
      .from(bucket)
      .createSignedUrl(storagePath, 60 * 60 * 24 * 365);

    if (signedError || !signedData?.signedUrl) {
      log.error("Signed URL error:", bucket, signedError);
      return NextResponse.json({ error: "Failed to generate signed URL" }, { status: 500 });
    }

    return NextResponse.json({
      url: signedData.signedUrl,
      path: storagePath,
      bucket,
    });
  } catch (err) {
    log.error("Unexpected upload error:", err);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
