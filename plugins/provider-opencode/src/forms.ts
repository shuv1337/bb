import {
  USER_QUESTION_MAX_OPTIONS,
  USER_QUESTION_MAX_QUESTIONS,
  type PendingInteractionPayload,
} from "@get-bb/plugin-sdk/provider-bridge";

export type OpenCodeFormFieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "multiselect"
  | "external";

export interface OpenCodeFormOption {
  value: string;
  label: string;
  description?: string;
}

export interface OpenCodeFormField {
  key: string;
  title: string;
  type: OpenCodeFormFieldType;
  required: boolean;
  custom: boolean;
  options: OpenCodeFormOption[] | undefined;
  url: string | undefined;
}

export type OpenCodeFormValue = string | number | boolean | string[];

export interface OpenCodeFormAnswerEntry {
  selected: readonly string[];
  freeText?: string;
}

const FIELD_TYPES: readonly OpenCodeFormFieldType[] = [
  "string",
  "number",
  "integer",
  "boolean",
  "multiselect",
  "external",
];

function fieldType(value: string): OpenCodeFormFieldType | undefined {
  return FIELD_TYPES.find((type) => type === value);
}

const BOOLEAN_OPTIONS: OpenCodeFormOption[] = [
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
];

const EXTERNAL_DONE = "done";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function parseOptions(raw: unknown): OpenCodeFormOption[] | null | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    return null;
  }
  const options: OpenCodeFormOption[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const record = asRecord(entry);
    const value = asText(record?.value);
    if (value === undefined || seen.has(value)) {
      return null;
    }
    seen.add(value);
    const description = asText(record?.description);
    options.push({
      value,
      label: asText(record?.label) ?? value,
      ...(description !== undefined ? { description } : {}),
    });
  }
  return options.length > 0 ? options : undefined;
}

export function parseOpenCodeFormFields(raw: unknown): OpenCodeFormField[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const fields: OpenCodeFormField[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const key = asText(record?.key);
    const type = fieldType(asText(record?.type) ?? "string");
    if (record === null || key === undefined || type === undefined) {
      return null;
    }
    if (record.hidden === true) {
      continue;
    }
    const options = parseOptions(record.options);
    if (options === null) {
      return null;
    }
    const url = asText(record.url);
    if (type === "multiselect" && options === undefined) {
      return null;
    }
    if (type === "external" && url === undefined) {
      return null;
    }
    const title = asText(record.title) ?? key;
    const description = asText(record.description);
    fields.push({
      key,
      title: description !== undefined ? `${title}\n${description}` : title,
      type,
      required: record.required === true,
      custom: record.custom === true,
      options,
      url,
    });
  }
  return fields.length > 0 ? fields : null;
}

function listed(options: readonly OpenCodeFormOption[]): string {
  return options.map((option) => option.value).join(", ");
}

function fitsOptions(field: OpenCodeFormField): boolean {
  return (
    field.options !== undefined && field.options.length <= USER_QUESTION_MAX_OPTIONS
  );
}

function questionFor(field: OpenCodeFormField) {
  const base = { id: field.key, multiSelect: false };
  switch (field.type) {
    case "boolean":
      return { ...base, prompt: field.title, options: BOOLEAN_OPTIONS, allowFreeText: false };
    case "number":
    case "integer":
      return {
        ...base,
        prompt: `${field.title} (${field.type === "integer" ? "whole number" : "number"})`,
        allowFreeText: true,
      };
    case "external":
      return {
        ...base,
        prompt: `${field.title}\n${field.url ?? ""}`,
        options: [{ value: EXTERNAL_DONE, label: "Done" }],
        allowFreeText: false,
      };
    case "multiselect":
      if (fitsOptions(field)) {
        return {
          ...base,
          prompt: field.title,
          multiSelect: true,
          options: field.options,
          allowFreeText: field.custom,
        };
      }
      return {
        ...base,
        prompt: `${field.title} (comma-separated: ${listed(field.options ?? [])})`,
        allowFreeText: true,
      };
    case "string":
      if (field.options === undefined) {
        return { ...base, prompt: field.title, allowFreeText: true };
      }
      if (fitsOptions(field)) {
        return {
          ...base,
          prompt: field.title,
          options: field.options,
          allowFreeText: field.custom,
        };
      }
      return {
        ...base,
        prompt: `${field.title} (one of: ${listed(field.options)})`,
        allowFreeText: true,
      };
  }
}

export function openCodeFormPage(
  fields: readonly OpenCodeFormField[],
  offset: number,
): OpenCodeFormField[] {
  return fields.slice(offset, offset + USER_QUESTION_MAX_QUESTIONS);
}

export function openCodeFormQuestionPayload(
  page: readonly OpenCodeFormField[],
): PendingInteractionPayload {
  return { kind: "user_question", questions: page.map(questionFor) };
}

function allowedValue(field: OpenCodeFormField, value: string): string {
  if (
    field.options !== undefined &&
    !field.custom &&
    !field.options.some((option) => option.value === value)
  ) {
    throw new Error(`OpenCode form field ${field.key} does not accept ${value}`);
  }
  return value;
}

function answerText(entry: OpenCodeFormAnswerEntry): string | undefined {
  const text = entry.freeText ?? entry.selected[0];
  return text !== undefined && text.trim().length > 0 ? text.trim() : undefined;
}

function fieldValue(
  field: OpenCodeFormField,
  entry: OpenCodeFormAnswerEntry,
): OpenCodeFormValue | undefined {
  if (field.type === "multiselect") {
    const values =
      entry.selected.length > 0
        ? [...entry.selected]
        : (entry.freeText ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter((value) => value.length > 0);
    if (entry.selected.length > 0 && entry.freeText !== undefined) {
      values.push(entry.freeText.trim());
    }
    return values.length > 0 ? values.map((value) => allowedValue(field, value)) : undefined;
  }
  const text = answerText(entry);
  if (text === undefined) {
    return undefined;
  }
  switch (field.type) {
    case "boolean":
      if (text !== "true" && text !== "false") {
        throw new Error(`OpenCode form field ${field.key} expects yes or no`);
      }
      return text === "true";
    case "number":
    case "integer": {
      const parsed = Number(text);
      if (!Number.isFinite(parsed) || (field.type === "integer" && !Number.isInteger(parsed))) {
        throw new Error(`OpenCode form field ${field.key} expects a ${field.type}`);
      }
      return parsed;
    }
    case "external":
      return undefined;
    case "string":
      return allowedValue(field, text);
  }
}

export function openCodeFormPageAnswer(
  page: readonly OpenCodeFormField[],
  answers: Readonly<Record<string, OpenCodeFormAnswerEntry>>,
): Record<string, OpenCodeFormValue> {
  const out: Record<string, OpenCodeFormValue> = {};
  for (const field of page) {
    const entry = answers[field.key];
    const value = entry === undefined ? undefined : fieldValue(field, entry);
    if (value === undefined) {
      if (field.required && field.type !== "external") {
        throw new Error(`OpenCode form field ${field.key} is required`);
      }
      continue;
    }
    out[field.key] = value;
  }
  return out;
}
