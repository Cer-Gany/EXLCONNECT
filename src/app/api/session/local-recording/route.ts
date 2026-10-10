import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FILENAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,179}$/;

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return errorResponse("Authentication required", 401);
    }

    const requestUrl = new URL(req.url);
    const sessionId = requestUrl.searchParams.get("sessionId");
    const filename = requestUrl.searchParams.get("filename");

    if (
      !sessionId ||
      !UUID_PATTERN.test(sessionId) ||
      !filename ||
      !FILENAME_PATTERN.test(filename) ||
      filename.includes("..")
    ) {
      return errorResponse("Invalid recording request", 400);
    }

    // Verify that the signed-in recruiter has access to this session's project.
    const { data: session, error: sessionError } = await supabase
      .from("sessions")
      .select(
        "id, interview:interviews!inner(projectId, project:projects!inner(organizationId))",
      )
      .eq("id", sessionId)
      .maybeSingle();

    if (sessionError) {
      console.error("Local recording session lookup failed:", sessionError);
      return errorResponse("Could not verify recording access", 500);
    }

    if (!session) {
      return errorResponse("Interview session not found", 404);
    }

    const sessionRow = session as unknown as {
      id: string;
      interview:
        | {
            projectId: string;
            project:
              | { organizationId: string }
              | { organizationId: string }[];
          }
        | {
            projectId: string;
            project:
              | { organizationId: string }
              | { organizationId: string }[];
          }[];
    };

    const interviewValue = Array.isArray(sessionRow.interview)
      ? sessionRow.interview[0]
      : sessionRow.interview;

    const projectValue = interviewValue
      ? Array.isArray(interviewValue.project)
        ? interviewValue.project[0]
        : interviewValue.project
      : null;

    if (!interviewValue || !projectValue?.organizationId || !interviewValue.projectId) {
      return errorResponse("Interview project information not found", 404);
    }

    const organizationId = projectValue.organizationId;
    const projectId = interviewValue.projectId;

    const { data: membership, error: membershipError } = await supabase
      .from("organization_members")
      .select("role")
      .eq("workspaceId", organizationId)
      .eq("userId", user.id)
      .maybeSingle();

    if (membershipError) {
      console.error("Recording membership check failed:", membershipError);
      return errorResponse("Could not verify recording access", 500);
    }

    if (!membership) {
      return errorResponse("Access denied", 403);
    }

    const { count, error: countError } = await supabase
      .from("project_members")
      .select("id", { count: "exact", head: true })
      .eq("projectId", projectId);

    if (countError) {
      console.error("Recording project access lookup failed:", countError);
      return errorResponse("Could not verify project access", 500);
    }

    if ((count ?? 0) > 0) {
      const { data: projectMembership, error: projectError } = await supabase
        .from("project_members")
        .select("id")
        .eq("projectId", projectId)
        .eq("userId", user.id)
        .maybeSingle();

      if (projectError) {
        console.error("Recording project membership check failed:", projectError);
        return errorResponse("Could not verify project access", 500);
      }

      if (!projectMembership) {
        return errorResponse("Access denied", 403);
      }
    }

    const root = path.resolve(
      process.env.LOCAL_RECORDINGS_DIR ||
        path.join(process.cwd(), "recordings"),
    );

    const sessionDirectory = path.resolve(root, sessionId);
    const filePath = path.resolve(sessionDirectory, filename);

    if (
      !sessionDirectory.startsWith(`${root}${path.sep}`) ||
      !filePath.startsWith(`${sessionDirectory}${path.sep}`)
    ) {
      return errorResponse("Invalid recording path", 400);
    }

    let fileInfo;

    try {
      fileInfo = await stat(filePath);
    } catch {
      return errorResponse("Recording not found on this server", 404);
    }

    if (!fileInfo.isFile()) {
      return errorResponse("Recording not found", 404);
    }

    const ext = path.extname(filename).toLowerCase();

    const contentTypes: Record<string, string> = {
      ".webm": "video/webm",
      ".mp4": "video/mp4",
      ".m4a": "audio/mp4",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".ogg": "audio/ogg",
      ".ogv": "video/ogg",
    };

    const contentType = contentTypes[ext];

    if (!contentType) {
      return errorResponse("Unsupported recording format", 415);
    }

    const headers = new Headers({
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    });

    const range = req.headers.get("range");
    let start = 0;
    let end = fileInfo.size - 1;
    let status = 200;

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());

      if (!match || fileInfo.size === 0) {
        return new Response(null, {
          status: 416,
          headers: {
            "Content-Range": `bytes */${fileInfo.size}`,
            "Cache-Control": "private, no-store",
          },
        });
      }

      const [, startText, endText] = match;

      if (startText === "" && endText === "") {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${fileInfo.size}` },
        });
      }

      if (startText === "") {
        const suffixLength = Number(endText);

        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
          return new Response(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${fileInfo.size}` },
          });
        }

        start = Math.max(fileInfo.size - suffixLength, 0);
      } else {
        start = Number(startText);
        end = endText === "" ? fileInfo.size - 1 : Number(endText);
      }

      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start >= fileInfo.size ||
        end < start
      ) {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${fileInfo.size}` },
        });
      }

      end = Math.min(end, fileInfo.size - 1);
      status = 206;

      headers.set("Content-Range", `bytes ${start}-${end}/${fileInfo.size}`);
    }

    const contentLength = fileInfo.size === 0 ? 0 : end - start + 1;
    headers.set("Content-Length", String(contentLength));

    if (req.method === "HEAD" || contentLength === 0) {
      return new Response(null, { status, headers });
    }

    const stream = createReadStream(filePath, { start, end });

    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status,
      headers,
    });
  } catch (error) {
    console.error("Local recording playback error:", error);
    return errorResponse("Failed to read recording", 500);
  }
}
