import { NextResponse } from "next/server";

export type ApiSuccess<T> = {
  success: true;
  data: T;
};

export type ApiFailure = {
  success: false;
  error: string;
  code?: string;
};

export function apiOk<T>(data: T, init?: ResponseInit) {
  return NextResponse.json<ApiSuccess<T>>(
    { success: true, data },
    { status: 200, ...init },
  );
}

export function apiCreated<T>(data: T, init?: ResponseInit) {
  return NextResponse.json<ApiSuccess<T>>(
    { success: true, data },
    { status: 201, ...init },
  );
}

export function apiError(
  error: string,
  status = 400,
  code?: string,
  init?: ResponseInit,
) {
  return NextResponse.json<ApiFailure>(
    { success: false, error, code },
    { status, ...init },
  );
}
