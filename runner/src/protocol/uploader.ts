import { HttpError } from "./client.js";
import type { ArtifactKind, ArtifactRef } from "./schemas.js";
import { z } from "zod";

const slotSchema = z.object({ storage_key: z.string().min(1), upload_url: z.string().url() });

/** Uploads evidence straight to object storage through a URL issued by the control plane (CLAUDE.md, seção 10). */
export class HttpUploader {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly runId: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async upload(kind: string, contentType: string, bytes: Uint8Array): Promise<ArtifactRef> {
    const path = `/runner/v1/jobs/${this.runId}/artifacts`;
    const slotRes = await this.fetchFn(this.baseUrl + path, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ kind, content_type: contentType }),
    });
    if (!slotRes.ok) throw new HttpError(slotRes.status, path);
    const slot = slotSchema.parse(await slotRes.json());

    // the storage URL is self-authenticating: never send the control-plane token there
    const put = await this.fetchFn(slot.upload_url, { method: "PUT", headers: { "content-type": contentType }, body: bytes as BodyInit });
    if (!put.ok) throw new HttpError(put.status, "object storage upload");
    return { kind: kind as ArtifactKind, content_type: contentType, storage_key: slot.storage_key };
  }
}
