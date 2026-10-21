import "server-only";
import {
  ACCEPTED_IMAGE_TYPES,
  CUTOUT_IMAGE_TYPE,
  LinkCutoutMetaSchema,
  MAX_CUTOUT_BYTES,
  MAX_ORIGINAL_BYTES,
  PhotoUploadFieldsSchema,
  UPLOAD_FIELDS,
  type AcceptedImageType,
  type LinkCutoutMeta,
} from "@/contracts";
import { sniffImageType } from "@/lib/images/server";
import { ApiException } from "./errors";

/**
 * Parsing for the multipart upload routes (POST /api/items/photo and
 * POST /api/items/link/cutout).
 *
 * Checked here: required fields, real file type (from the bytes, not the
 * declared type) and byte size. NOT checked here: pixel dimensions, which
 * need the image decoded. The ingestion agent must also run
 * ServerImageProcessor.inspect + checkImage, then stripMetadata, before
 * storing anything (src/lib/images/server.ts).
 */

export interface UploadedImage {
  data: Uint8Array;
  mimeType: AcceptedImageType;
  /** The file name the phone sent. Untrusted: for logs and mock markers only, never for storage keys. */
  name: string;
}

interface ImageFieldRules {
  label: string;
  allowedTypes: readonly AcceptedImageType[];
  maxBytes: number;
}

const ORIGINAL_RULES: ImageFieldRules = { label: "photo", allowedTypes: ACCEPTED_IMAGE_TYPES, maxBytes: MAX_ORIGINAL_BYTES };
const CUTOUT_RULES: ImageFieldRules = { label: "cut-out", allowedTypes: [CUTOUT_IMAGE_TYPE], maxBytes: MAX_CUTOUT_BYTES };

function fieldError(field: string, message: string, detail: string): ApiException {
  return new ApiException("bad_request", message, { issues: [{ path: field, message: detail }] });
}

async function readForm(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    throw new ApiException("bad_request", "Send the images as multipart/form-data");
  }
}

async function readImage(form: FormData, field: string, rules: ImageFieldRules, required: boolean): Promise<UploadedImage | null> {
  const value = form.get(field);
  if (value === null || (value instanceof File && value.size === 0)) {
    if (required) throw fieldError(field, `Choose a ${rules.label} to upload`, "Missing file");
    return null;
  }
  if (!(value instanceof File)) throw fieldError(field, `The ${rules.label} must be a file`, "Not a file");
  if (value.size > rules.maxBytes) {
    const mb = (rules.maxBytes / (1024 * 1024)).toFixed(1);
    throw fieldError(field, `That ${rules.label} is too large`, `Must be under ${mb} MB`);
  }

  const data = new Uint8Array(await value.arrayBuffer());
  const mimeType = sniffImageType(data);
  if (!mimeType || !rules.allowedTypes.includes(mimeType)) {
    const allowed = rules.allowedTypes.map((t) => t.replace("image/", "").toUpperCase()).join(", ");
    throw fieldError(field, `The ${rules.label} must be ${allowed}`, `Unsupported file type`);
  }
  return { data, mimeType, name: value.name };
}

export interface PhotoUpload {
  original: UploadedImage;
  cutout: UploadedImage | null;
  sourceUrl: string | undefined;
}

/** POST /api/items/photo: `original` (required), `cutout` (optional), `sourceUrl` (optional). */
export async function parsePhotoUpload(request: Request): Promise<PhotoUpload> {
  const form = await readForm(request);
  const original = await readImage(form, UPLOAD_FIELDS.original, ORIGINAL_RULES, true);
  const cutout = await readImage(form, UPLOAD_FIELDS.cutout, CUTOUT_RULES, false);

  const rawSourceUrl = form.get(UPLOAD_FIELDS.sourceUrl);
  const fields = PhotoUploadFieldsSchema.safeParse({
    sourceUrl: typeof rawSourceUrl === "string" && rawSourceUrl !== "" ? rawSourceUrl : undefined,
  });
  if (!fields.success) {
    throw fieldError(UPLOAD_FIELDS.sourceUrl, "The source link isn't valid", "Must be an http or https link");
  }

  return { original: original!, cutout, sourceUrl: fields.data.sourceUrl };
}

export interface LinkCutoutUpload {
  meta: LinkCutoutMeta;
  cutout: UploadedImage | null;
}

/** POST /api/items/link/cutout: `meta` (JSON text, required), `cutout` (optional). */
export async function parseLinkCutoutUpload(request: Request): Promise<LinkCutoutUpload> {
  const form = await readForm(request);
  const rawMeta = form.get(UPLOAD_FIELDS.meta);
  let metaJson: unknown;
  try {
    metaJson = typeof rawMeta === "string" ? JSON.parse(rawMeta) : undefined;
  } catch {
    metaJson = undefined;
  }
  const meta = LinkCutoutMetaSchema.safeParse(metaJson);
  if (!meta.success) {
    throw new ApiException("bad_request", "The link details are missing or invalid", {
      issues: meta.error.issues.map((i) => ({ path: [UPLOAD_FIELDS.meta, ...i.path.map(String)].join("."), message: i.message })),
    });
  }
  const cutout = await readImage(form, UPLOAD_FIELDS.cutout, CUTOUT_RULES, false);
  return { meta: meta.data, cutout };
}
