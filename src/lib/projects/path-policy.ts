import { isAbsolute, normalize, relative, resolve } from "node:path";

export function assertProjectPathAllowed(
  candidate: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!isAbsolute(candidate)) throw new Error("PROJECT_PATH_MUST_BE_ABSOLUTE");
  const target = canonical(candidate);
  const allowedRoots = parseRoots(env.COMPANY_PROJECTS_ALLOWED_ROOTS ?? env.COMPANY_OS_PROJECT_ROOT ?? process.cwd());
  const forbiddenRoots = parseRoots(env.COMPANY_PROJECTS_FORBIDDEN_ROOTS ?? "");
  if (!allowedRoots.some((root) => contains(root, target))) throw new Error("PROJECT_PATH_OUTSIDE_ALLOWED_ROOTS");
  if (forbiddenRoots.some((root) => contains(root, target))) throw new Error("PROJECT_PATH_FORBIDDEN");
  return target;
}

export function configuredProjectRoots(env: NodeJS.ProcessEnv = process.env): {
  allowedRoots: string[];
  forbiddenRoots: string[];
} {
  return {
    allowedRoots: parseRoots(env.COMPANY_PROJECTS_ALLOWED_ROOTS ?? env.COMPANY_OS_PROJECT_ROOT ?? process.cwd()),
    forbiddenRoots: parseRoots(env.COMPANY_PROJECTS_FORBIDDEN_ROOTS ?? ""),
  };
}

function parseRoots(value: string): string[] {
  return [...new Set(value.split(";").map((item) => item.trim()).filter(Boolean).map(canonical))];
}

function canonical(value: string): string {
  const normalized = normalize(resolve(value));
  const trimmed = normalized.length > 3 ? normalized.replace(/[\\/]+$/, "") : normalized;
  return /^[a-z]:/i.test(trimmed) ? trimmed[0].toUpperCase() + trimmed.slice(1) : trimmed;
}

function contains(root: string, target: string): boolean {
  const result = relative(root, target);
  return result === "" || (!result.startsWith("..") && !isAbsolute(result));
}
