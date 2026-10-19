import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  type LLMProvider,
  type GenerationParams,
  type LLMResponse,
  type LLMMessage,
} from "../types";

export class GroqProvider implements LLMProvider {
  id = "groq";
  name = "Groq";
  models = [
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "llama-3.3-70b-versatile",
  ];
  defaultModel = "openai/gpt-oss-120b";

  private client: OpenAI | null = null;

  private ensureClient(): OpenAI {
    if (!this.client) {
      const apiKey = process.env.GROQ_API_KEY?.trim();
      if (!apiKey) {
        throw new Error("GROQ_API_KEY is not configured");
      }
      this.client = new OpenAI({
        apiKey,
        baseURL: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
      });
    }
    return this.client;
  }

  private toOpenAIMessages(messages: LLMMessage[]): ChatCompletionMessageParam[] {
    return messages.map((m) => ({
      role: m.role,
      content: m.content as string & Array<unknown>,
    })) as ChatCompletionMessageParam[];
  }

  async generateResponse(
    params: GenerationParams & { model?: string },
  ): Promise<LLMResponse> {
    const client = this.ensureClient();
    const model = params.model ?? this.defaultModel;
    const response = await client.chat.completions.create({
      model,
      messages: this.toOpenAIMessages(params.messages),
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens ?? 2048,
    });

    const choice = response.choices[0];
    return {
      content: choice?.message?.content ?? "",
      finishReason: choice?.finish_reason ?? "stop",
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined,
    };
  }

  async *streamResponse(
    params: GenerationParams & { model?: string },
  ): AsyncIterable<string> {
    const client = this.ensureClient();
    const model = params.model ?? this.defaultModel;
    const stream = await client.chat.completions.create({
      model,
      messages: this.toOpenAIMessages(params.messages),
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens ?? 2048,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  }
}
