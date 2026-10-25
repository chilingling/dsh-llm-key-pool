/**
 * Token usage read from an OpenAI-compatible answer while it is forwarded.
 *
 * @module dsh-llm-key-pool/usage
 */

/** Usage object shared by Chat Completions and Responses answers. */
interface UsageCarrier {
  usage?: { total_tokens?: unknown } | null
  response?: { usage?: { total_tokens?: unknown } | null }
}

/** `total_tokens` of the usage object a parsed answer or stream event carries. */
function totalOf(value: UsageCarrier): number | undefined {
  const total = value.usage?.total_tokens ?? value.response?.usage?.total_tokens
  return typeof total === 'number' && Number.isFinite(total) ? total : undefined
}

/**
 * Accumulates one answer body and reports the provider's `total_tokens`,
 * cached input included. Event streams carry it in the Chat Completions
 * final chunk or the Responses `response.completed` event; other bodies are
 * one JSON document.
 */
export class UsageReader {
  private readonly decoder = new TextDecoder()
  private pending = ''
  private total: number | undefined

  /** @param stream - whether the body is a server-sent event stream. */
  constructor(private readonly stream: boolean) {}

  /** @param chunk - the next body bytes. */
  push(chunk: Uint8Array): void {
    this.pending += this.decoder.decode(chunk, { stream: true })
    if (!this.stream) return
    const lines = this.pending.split('\n')
    this.pending = lines.pop() ?? ''
    for (const line of lines) this.readEvent(line)
  }

  /** @returns the reported total once the body ended, or `undefined` when the answer reported none. */
  finish(): number | undefined {
    this.pending += this.decoder.decode()
    if (this.stream) this.readEvent(this.pending)
    else this.readJson(this.pending)
    this.pending = ''
    return this.total
  }

  private readEvent(line: string): void {
    // Only the usage-bearing event is parsed; content deltas pass through untouched.
    if (!line.startsWith('data:') || !line.includes('"total_tokens"')) return
    this.readJson(line.slice('data:'.length))
  }

  private readJson(text: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return // A body that is not JSON reports no usage; the request keeps its estimate.
    }
    if (typeof parsed === 'object' && parsed !== null) this.total = totalOf(parsed as UsageCarrier) ?? this.total
  }
}
