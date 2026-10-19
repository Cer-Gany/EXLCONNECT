import { mergeRecordingEntries, mergeScreenshotEntries, shouldReplaceRecordingReference, type SessionRecordingEntry, type SessionScreenshotEntry } from "@/lib/session-media";
import { createLogger } from "@/lib/logger";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { filterAccessibleProjectIds, hasProjectAccess, protectedProcedure, publicProcedure, router } from "../trpc";

const log = createLogger("router/session");

export const sessionRouter = router({
  create: publicProcedure
    .input(
      z.object({
        interviewSlug: z.string(),
        participantName: z.string().optional(),
        participantEmail: z.string().email().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { data: interview } = await ctx.supabase
        .from("interviews")
        .select("*, questions(*)")
        .eq("publicSlug", input.interviewSlug)
        .eq("isActive", true)
        .order("order", { referencedTable: "questions", ascending: true })
        .single();

      if (!interview) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Interview not found or inactive",
        });
      }

      // Enforce invite-only access via candidates table
      if (interview.requireInvite) {
        const email = input.participantEmail?.trim().toLowerCase();
        if (!email) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Email is required for invite-only interviews.",
          });
        }
        const { data: candidate } = await ctx.supabase
          .from("candidates")
          .select("id")
          .eq("interviewId", interview.id)
          .eq("email", email)
          .single();

        if (!candidate) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Your email is not on the invite list for this interview.",
          });
        }
      }

      const questions = (interview.questions ?? []) as { id: string }[];

      const derivedMode = interview.voiceEnabled ? "VOICE" : "CHAT";

      const { data: sessionJson, error } = await ctx.supabase.rpc(
        "create_interview_session",
        {
          p_interview_id: interview.id,
          p_participant_name: input.participantName ?? null,
          p_participant_email: input.participantEmail ?? null,
          p_mode_used: derivedMode,
          p_current_question_id: questions[0]?.id ?? null,
        },
      );

      if (error) {
        log.error("RPC error (create):", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error.message,
        });
      }

      const session = sessionJson as { id: string };

      return { sessionId: session.id, interview };
    }),

  createPreview: protectedProcedure
    .input(
      z.object({
        interviewId: z.string(),
        questionId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { data: interviewAccess } = await ctx.supabase
        .from("interviews")
        .select("id, projectId, project:projects!inner(organizationId)")
        .eq("id", input.interviewId)
        .single();

      if (!interviewAccess) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Interview not found" });
      }

      const project = interviewAccess.project as unknown as { organizationId: string };
      const { data: membership } = await ctx.supabase
        .from("organization_members")
        .select("role")
        .eq("workspaceId", project.organizationId)
        .eq("userId", ctx.user.id)
        .single();

      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You are not a member of this organization",
        });
      }

      const projAccess = await hasProjectAccess(
        ctx.supabase,
        interviewAccess.projectId,
        ctx.user.id,
      );
      if (!projAccess) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not have access to this project",
        });
      }

      const { data: interview } = await ctx.supabase
        .from("interviews")
        .select("*, questions(*)")
        .eq("id", input.interviewId)
        .order("order", { referencedTable: "questions", ascending: true })
        .single();

      if (!interview) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Interview not found" });
      }
      if (!interview.publicSlug || !interview.isActive) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Publish the interview before opening a preview session.",
        });
      }

      const { data: profile } = await ctx.supabase
        .from("profiles")
        .select("name, email")
        .eq("id", ctx.user.id)
        .single();

      const questions = (interview.questions ?? []) as { id: string }[];
      const targetQuestionId =
        input.questionId && questions.some((question) => question.id === input.questionId)
          ? input.questionId
          : questions[0]?.id ?? null;
      const derivedMode = interview.voiceEnabled ? "VOICE" : "CHAT";

      const { data: sessionJson, error } = await ctx.supabase.rpc(
        "create_interview_session",
        {
          p_interview_id: interview.id,
          p_participant_name: profile?.name ?? "Preview User",
          p_participant_email: profile?.email ?? ctx.user.email ?? null,
          p_mode_used: derivedMode,
          p_current_question_id: targetQuestionId,
        },
      );

      if (error) {
        log.error("RPC error (createPreview):", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      }

      const session = sessionJson as { id: string };
      return { sessionId: session.id, slug: interview.publicSlug };
    }),

  createFromInvite: publicProcedure
    .input(z.object({ inviteToken: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Look up candidate + interview via the RPC
      const { data: candidate } = await ctx.supabase
        .from("candidates")
        .select("*, interview:interviews(*, questions(*))")
        .eq("inviteToken", input.inviteToken)
        // The first question is what a new session starts on, so the rows must not arrive unordered.
        .order("order", { referencedTable: "interviews.questions", ascending: true })
        .single();

      if (!candidate) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invalid invite link" });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const interview = candidate.interview as any;
      if (!interview) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Interview is no longer available" });
      }

      // If session already exists, return it
      if (candidate.sessionId) {
        const { data: existingSession } = await ctx.supabase
          .from("sessions")
          .select("*")
          .eq("id", candidate.sessionId)
          .single();

        if (existingSession) {
          return { sessionId: existingSession.id, interview, isExisting: true };
        }
      }

      // Sort questions
      const questions = (interview.questions ?? []) as { id: string; order: number }[];
      questions.sort((a, b) => a.order - b.order);

      // Create session via RPC (also links it to the candidate)
      const derivedMode = interview.voiceEnabled ? "VOICE" : "CHAT";

      const { data: sessionJson, error } = await ctx.supabase.rpc(
        "create_invite_session",
        {
          p_invite_token: input.inviteToken,
          p_mode_used: derivedMode,
          p_current_question_id: questions[0]?.id ?? null,
        },
      );

      if (error) {
        log.error("RPC error (createFromInvite):", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      }

      const session = sessionJson as { id: string };
      return { sessionId: session.id, interview, isExisting: false };
    }),

  getById: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const { data: session } = await ctx.supabase
        .from("sessions")
        .select(
          "*, interview:interviews!inner(*, questions(*)), messages(*)",
        )
        .eq("id", input.id)
        .order("order", {
          referencedTable: "interviews.questions",
          ascending: true,
        })
        .order("timestamp", { referencedTable: "messages", ascending: true })
        .single();

      if (!session) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      return session;
    }),

  sendMessage: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        content: z.string().min(1),
        contentType: z
          .enum(["TEXT", "AUDIO", "FILE", "IMAGE", "WHITEBOARD"])
          .default("TEXT"),
        questionId: z.string().optional(),
        internal: z.boolean().optional().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { data: session } = await ctx.supabase
        .from("sessions")
        .select("id, status, startedAt, lastActivityAt, activitySegments, interviewId")
        .eq("id", input.sessionId)
        .single();

      if (!session) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      if (
        session.status === "COMPLETED" ||
        session.status === "ABANDONED"
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Session is no longer active",
        });
      }

      const { data: userMessage } = await ctx.supabase
        .from("messages")
        .insert({
          sessionId: input.sessionId,
          role: input.internal ? ("SYSTEM" as const) : ("USER" as const),
          content: input.content,
          contentType: input.contentType,
          questionId: input.questionId ?? null,
          wordCount: input.content.split(/\s+/).length,
        })
        .select()
        .single();

      await ctx.supabase
        .from("sessions")
        .update({ lastActivityAt: new Date().toISOString() })
        .eq("id", input.sessionId);

      return { userMessage };
    }),

  saveWhiteboard: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        drawingId: z.string(),
        label: z.string().optional(),
        snapshotData: z.string(),
        imageDataUrl: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { data: session } = await ctx.supabase
        .from("sessions")
        .select("id")
        .eq("id", input.sessionId)
        .single();

      if (!session) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      const { data: existing } = await ctx.supabase
        .from("messages")
        .select("id")
        .eq("sessionId", input.sessionId)
        .eq("contentType", "WHITEBOARD")
        .eq("content", input.drawingId)
        .single();

      const msgData = {
        sessionId: input.sessionId,
        role: "USER" as const,
        content: input.drawingId,
        contentType: "WHITEBOARD" as const,
        whiteboardData: {
          ...JSON.parse(input.snapshotData),
          label: input.label ?? "Drawing",
        },
        ...(input.imageDataUrl
          ? { whiteboardImageUrl: input.imageDataUrl }
          : {}),
      };

      let message;
      if (existing) {
        const { data } = await ctx.supabase
          .from("messages")
          .update(msgData)
          .eq("id", existing.id)
          .select()
          .single();
        message = data;
      } else {
        const { data } = await ctx.supabase
          .from("messages")
          .insert(msgData)
          .select()
          .single();
        message = data;
      }

      return { message };
    }),

  deleteWhiteboard: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        drawingId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.supabase
        .from("messages")
        .delete()
        .eq("sessionId", input.sessionId)
        .eq("contentType", "WHITEBOARD")
        .eq("content", input.drawingId);

      return { success: true };
    }),

  saveCode: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        snippetId: z.string(),
        label: z.string().optional(),
        snapshotData: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { data: session } = await ctx.supabase
        .from("sessions")
        .select("id")
        .eq("id", input.sessionId)
        .single();

      if (!session) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      const { data: existing } = await ctx.supabase
        .from("messages")
        .select("id")
        .eq("sessionId", input.sessionId)
        .eq("contentType", "CODE")
        .eq("content", input.snippetId)
        .single();

      const parsed = JSON.parse(input.snapshotData);
      const msgData = {
        sessionId: input.sessionId,
        role: "USER" as const,
        content: input.snippetId,
        contentType: "CODE" as const,
        whiteboardData: {
          ...parsed,
          label: input.label ?? "Code Snippet",
        },
      };

      let message;
      if (existing) {
        const { data } = await ctx.supabase
          .from("messages")
          .update(msgData)
          .eq("id", existing.id)
          .select()
          .single();
        message = data;
      } else {
        const { data } = await ctx.supabase
          .from("messages")
          .insert(msgData)
          .select()
          .single();
        message = data;
      }

      return { message };
    }),

  deleteCode: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        snippetId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.supabase
        .from("messages")
        .delete()
        .eq("sessionId", input.sessionId)
        .eq("contentType", "CODE")
        .eq("content", input.snippetId);

      return { success: true };
    }),

  updateCurrentQuestion: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        questionId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.supabase
        .from("sessions")
        .update({
          currentQuestionId: input.questionId,
          lastActivityAt: new Date().toISOString(),
        })
        .eq("id", input.sessionId);
      return { success: true };
    }),

  complete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { data: session } = await ctx.supabase
        .from("sessions")
        .select("id, startedAt")
        .eq("id", input.id)
        .single();

      if (!session) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      const { data: firstMsg } = await ctx.supabase
        .from("messages")
        .select("timestamp")
        .eq("sessionId", input.id)
        .order("timestamp", { ascending: true })
        .limit(1)
        .single();

      const actualStart = firstMsg?.timestamp
        ? new Date(firstMsg.timestamp).getTime()
        : new Date(session.startedAt).getTime();
      const now = new Date();
      const duration = Math.round((now.getTime() - actualStart) / 1000);

      const { error: completionError } = await ctx.supabase
        .from("sessions")
        .update({
          status: "COMPLETED" as const,
          completedAt: now.toISOString(),
          startedAt: new Date(actualStart).toISOString(),
          totalDurationSeconds: duration,
        })
        .eq("id", input.id);

      if (completionError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: completionError.message });

      return { success: true };
    }),

  reportAntiCheatingViolation: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        violation: z.object({
          type: z.enum([
            "page_departure",
            "paste",
            "multi_screen",
            "tab_switch",
            "focus_lost",
            "copy",
            "cut",
            "multiple_faces",
            "face_not_visible",
            "looking_away",
            "prohibited_object",
          ]),
          timestamp: z.number(),
          detail: z.string().optional(),
        }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { data: session } = await ctx.supabase
        .from("sessions")
        .select("antiCheatingLog")
        .eq("id", input.sessionId)
        .single();

      if (!session) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
      }

      const log = Array.isArray(session.antiCheatingLog) ? session.antiCheatingLog : [];
      log.push(input.violation);

      await ctx.supabase
        .from("sessions")
        .update({ antiCheatingLog: log })
        .eq("id", input.sessionId);

      return { success: true };
    }),

  listAll: protectedProcedure
    .input(
      z.object({
        status: z
          .enum(["IN_PROGRESS", "COMPLETED", "ABANDONED"])
          .optional(),
        limit: z.number().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Get interviews accessible via org membership
      const { data: memberships } = await ctx.supabase
        .from("organization_members")
        .select("workspaceId")
        .eq("userId", ctx.user.id);

      const orgIds = (memberships ?? []).map(
        (m: { workspaceId: string }) => m.workspaceId,
      );
      if (orgIds.length === 0) return { sessions: [] };

      const { data: projects } = await ctx.supabase
        .from("projects")
        .select("id")
        .in("organizationId", orgIds);

      const allProjIds = (projects ?? []).map((p: { id: string }) => p.id);
      const projectIds = await filterAccessibleProjectIds(ctx.supabase, allProjIds, ctx.user.id);
      if (projectIds.length === 0) return { sessions: [] };

      const { data: userInterviews } = await ctx.supabase
        .from("interviews")
        .select("id")
        .in("projectId", projectIds);

      const interviewIds = (userInterviews ?? []).map((i: { id: string }) => i.id);
      if (interviewIds.length === 0) return { sessions: [] };

      let query = ctx.supabase
        .from("sessions")
        .select(
          "*, interview:interviews!inner(id, title, chatEnabled, voiceEnabled, videoEnabled), messages(id)",
        )
        .in("interviewId", interviewIds)
        .order("createdAt", { ascending: false })
        .limit(input.limit);

      if (input.status) {
        query = query.eq("status", input.status);
      }

      const { data: raw } = await query;

      const sessions = (raw ?? []).map((s) => ({
        ...s,
        _count: {
          messages: (s.messages as { id: string }[])?.length ?? 0,
        },
      }));

      return { sessions };
    }),

  listByInterview: protectedProcedure
    .input(
      z.object({
        interviewId: z.string(),
        status: z
          .enum(["IN_PROGRESS", "COMPLETED", "ABANDONED"])
          .optional(),
        limit: z.number().min(1).max(100).default(20),
        cursor: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { data: interview } = await ctx.supabase
        .from("interviews")
        .select("id, projectId, project:projects!inner(organizationId)")
        .eq("id", input.interviewId)
        .single();

      if (!interview) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      const project = interview.project as unknown as { organizationId: string };
      const { data: membership } = await ctx.supabase
        .from("organization_members")
        .select("role")
        .eq("workspaceId", project.organizationId)
        .eq("userId", ctx.user.id)
        .single();

      if (!membership) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You are not a member of this organization" });
      }

      const projAccess = await hasProjectAccess(ctx.supabase, interview.projectId, ctx.user.id);
      if (!projAccess) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You do not have access to this project" });
      }

      const limit = input.limit;

      let query = ctx.supabase
        .from("sessions")
        .select("*, messages(id)")
        .eq("interviewId", input.interviewId)
        .order("createdAt", { ascending: false })
        .limit(limit + 1);

      if (input.status) {
        query = query.eq("status", input.status);
      }

      const { data: raw } = await query;
      const rows = raw ?? [];

      const sessions = rows.slice(0, limit).map((s) => ({
        ...s,
        _count: {
          messages: (s.messages as { id: string }[])?.length ?? 0,
        },
      }));

      let nextCursor: string | undefined;
      if (rows.length > limit) {
        nextCursor = rows[limit - 1].id;
      }

      return { sessions, nextCursor };
    }),

  saveRecording: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        audioRecordingUrl: z.string().optional(),
        screenRecordingUrl: z.string().optional(),
        cameraRecordingUrl: z.string().optional(),
        audioDuration: z.number().nullable().optional(),
        segmentIndex: z.number().optional(),
        screenshots: z
          .array(
            z.object({
              url: z.string(),
              path: z.string(),
              timestamp: z.string(),
              type: z.enum(["camera", "screen"]),
            }),
          )
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const needsExistingMedia =
        input.screenshots !== undefined ||
        input.audioRecordingUrl !== undefined ||
        input.screenRecordingUrl !== undefined ||
        input.cameraRecordingUrl !== undefined;
      const { data: storedSession, error: mediaReadError } = needsExistingMedia
        ? await ctx.supabase
            .from("sessions")
            .select("audioRecordingUrl, screenRecordingUrl, cameraRecordingUrl, audioRecordings, screenshots")
            .eq("id", input.sessionId)
            .single()
        : { data: null, error: null };

      if (mediaReadError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: mediaReadError.message });

      const updateData: Record<string, unknown> = {};
      const shouldReplacePrimaryRecording = input.audioRecordingUrl
        ? shouldReplaceRecordingReference(
            storedSession?.audioRecordingUrl as string | null | undefined,
            input.audioRecordingUrl,
          )
        : true;
      if (input.audioRecordingUrl && shouldReplacePrimaryRecording) {
        updateData.audioRecordingUrl = input.audioRecordingUrl;
      }
      if (input.audioDuration !== undefined && shouldReplacePrimaryRecording) {
        updateData.audioDuration = input.audioDuration;
      }

      if (input.screenRecordingUrl) {
        updateData.screenRecordingUrl = input.screenRecordingUrl;
      }
      if (input.cameraRecordingUrl) {
        updateData.cameraRecordingUrl = input.cameraRecordingUrl;
      }
      if (input.screenshots !== undefined) {
        updateData.screenshots = mergeScreenshotEntries(
          (storedSession?.screenshots ?? []) as SessionScreenshotEntry[],
          input.screenshots,
        );
      }

      if (input.audioRecordingUrl && input.segmentIndex !== undefined) {
        const entry: SessionRecordingEntry = {
          url: input.audioRecordingUrl,
          duration: input.audioDuration ?? null,
          segmentIndex: input.segmentIndex,
          timestamp: new Date().toISOString(),
        };
        updateData.audioRecordings = mergeRecordingEntries(
          (storedSession?.audioRecordings ?? []) as SessionRecordingEntry[],
          entry,
        );
      }

      if (Object.keys(updateData).length === 0) {
        return { success: true };
      }

      const { error } = await ctx.supabase
        .from("sessions")
        .update(updateData)
        .eq("id", input.sessionId);

      if (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error.message,
        });
      }

      return { success: true };
    }),

  deleteMany: protectedProcedure
    .input(z.object({ ids: z.array(z.string()).min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { data: sessions } = await ctx.supabase
        .from("sessions")
        .select("id, interview:interviews!inner(projectId, project:projects!inner(organizationId))")
        .in("id", input.ids);

      await Promise.all(
        (sessions ?? []).map(async (s) => {
          const interviewData = s.interview as unknown as {
            projectId: string;
            project: { organizationId: string };
          };
          const orgId = interviewData?.project?.organizationId;
          if (!orgId) {
            throw new TRPCError({ code: "NOT_FOUND" });
          }
          const { data: membership } = await ctx.supabase
            .from("organization_members")
            .select("role")
            .eq("workspaceId", orgId)
            .eq("userId", ctx.user.id)
            .single();

          if (!membership) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Not authorized to delete these sessions",
            });
          }

          const projAccess = await hasProjectAccess(ctx.supabase, interviewData.projectId, ctx.user.id);
          if (!projAccess) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Not authorized to delete these sessions",
            });
          }
        })
      );

      await ctx.supabase.from("sessions").delete().in("id", input.ids);

      return { deleted: input.ids.length };
    }),

  publishLiveState: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        cameraFrame: z.string().max(350_000).optional(),
        screenFrame: z.string().max(500_000).optional(),
        aiState: z
          .enum(["speaking", "listening", "thinking", "transitioning", "idle"])
          .optional(),
        currentQuestionIndex: z.number().int().min(0).optional(),
        currentQuestionText: z.string().max(2000).optional(),
        userTranscript: z.string().max(4000).optional(),
        aiTranscript: z.string().max(4000).optional(),
        activeTool: z.enum(["voice", "whiteboard", "code", "chat"]).optional(),
        codeSnippet: z
          .object({
            language: z.string().max(64),
            code: z.string().max(50_000),
          })
          .optional(),
        messages: z
          .array(
            z.object({
              id: z.string(),
              role: z.enum(["user", "assistant"]),
              content: z.string().max(8000),
              source: z.enum(["voice", "chat"]).optional(),
            }),
          )
          .max(200)
          .optional(),
      }),
    )
    .mutation(({ input }) => {
      const store = getLiveSessionStore();
      const now = Date.now();

      // Prune stale sessions older than 90 seconds
      for (const [id, entry] of store.entries()) {
        if (now - entry.updatedAt > 90_000) {
          store.delete(id);
        }
      }

      const prev =
        store.get(input.sessionId) ?? readLiveSessionFromDisk(input.sessionId);
      const nextState: LiveSessionState = {
        sessionId: input.sessionId,
        cameraFrame: input.cameraFrame ?? prev?.cameraFrame,
        screenFrame: input.screenFrame ?? prev?.screenFrame,
        aiState: input.aiState ?? prev?.aiState ?? "idle",
        currentQuestionIndex:
          input.currentQuestionIndex ?? prev?.currentQuestionIndex ?? 0,
        currentQuestionText:
          input.currentQuestionText ?? prev?.currentQuestionText ?? "",
        userTranscript: input.userTranscript ?? prev?.userTranscript ?? "",
        aiTranscript: input.aiTranscript ?? prev?.aiTranscript ?? "",
        activeTool: input.activeTool ?? prev?.activeTool ?? "voice",
        codeSnippet: input.codeSnippet ?? prev?.codeSnippet,
        messages: input.messages ?? prev?.messages ?? [],
        updatedAt: now,
      };
      store.set(input.sessionId, nextState);
      writeLiveSessionToDisk(nextState);

      return { ok: true };
    }),

  getLiveState: protectedProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(({ input }) => {
      const store = getLiveSessionStore();
      const memEntry = store.get(input.sessionId);
      const diskEntry =
        !memEntry || Date.now() - memEntry.updatedAt > 2000
          ? readLiveSessionFromDisk(input.sessionId)
          : null;
      const entry =
        diskEntry && (!memEntry || diskEntry.updatedAt >= memEntry.updatedAt)
          ? diskEntry
          : memEntry;
      if (!entry) return null;
      if (diskEntry && entry === diskEntry) {
        store.set(input.sessionId, diskEntry);
      }
      // Consider live feed active if updated within the last 30 seconds
      const isLive = Date.now() - entry.updatedAt < 30_000;
      return {
        ...entry,
        isLive,
      };
    }),

  getAdaptiveResponses: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from("adaptive_question_responses")
        .select("*, question:questions(*)")
        .eq("sessionId", input.sessionId)
        .order("questionOrder", { ascending: true });

      if (error) {
        log.error("Failed to load adaptive responses", error);
        return [];
      }
      return data ?? [];
    }),
});

export interface LiveSessionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  source?: "voice" | "chat";
}

export interface LiveSessionState {
  sessionId: string;
  cameraFrame?: string;
  screenFrame?: string;
  aiState: "speaking" | "listening" | "thinking" | "transitioning" | "idle";
  currentQuestionIndex: number;
  currentQuestionText: string;
  userTranscript: string;
  aiTranscript: string;
  activeTool: "voice" | "whiteboard" | "code" | "chat";
  codeSnippet?: { language: string; code: string };
  messages?: LiveSessionMessage[];
  updatedAt: number;
}

const globalForLiveSessions = globalThis as unknown as {
  __liveSessionStates?: Map<string, LiveSessionState>;
};

function getLiveSessionStore(): Map<string, LiveSessionState> {
  if (!globalForLiveSessions.__liveSessionStates) {
    globalForLiveSessions.__liveSessionStates = new Map<
      string,
      LiveSessionState
    >();
  }
  return globalForLiveSessions.__liveSessionStates;
}

function getLiveSessionFilePath(sessionId: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path") as typeof import("node:path");
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(os.tmpdir(), "exlconnect-live-sessions", `${safeId}.json`);
}

function writeLiveSessionToDisk(state: LiveSessionState): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    const filePath = getLiveSessionFilePath(state.sessionId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state), "utf8");
  } catch {
    // Ignore disk cache errors
  }
}

function readLiveSessionFromDisk(sessionId: string): LiveSessionState | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    const filePath = getLiveSessionFilePath(sessionId);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as LiveSessionState;
    if (Date.now() - parsed.updatedAt > 90_000) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}


