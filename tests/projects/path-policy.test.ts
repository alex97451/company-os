import { describe, expect, it } from "vitest";
import { assertProjectPathAllowed } from "@/lib/projects/path-policy";

const baseEnv: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "test",
  COMPANY_PROJECTS_ALLOWED_ROOTS: "C:\\CompanyProjects;D:\\Approved",
  COMPANY_PROJECTS_FORBIDDEN_ROOTS: "C:\\CompanyProjects\\forbidden",
};

describe("company project path policy", () => {
  it("accepts only an absolute descendant of an allowed root", () => {
    expect(assertProjectPathAllowed("C:\\CompanyProjects\\my-saas", baseEnv)).toBe("C:\\CompanyProjects\\my-saas");
    expect(() => assertProjectPathAllowed("relative\\project", baseEnv)).toThrow("PROJECT_PATH_MUST_BE_ABSOLUTE");
    expect(() => assertProjectPathAllowed("E:\\Other\\project", baseEnv)).toThrow("PROJECT_PATH_OUTSIDE_ALLOWED_ROOTS");
  });

  it("blocks a forbidden root and all descendants", () => {
    expect(() => assertProjectPathAllowed("C:\\CompanyProjects\\forbidden", baseEnv)).toThrow("PROJECT_PATH_FORBIDDEN");
    expect(() => assertProjectPathAllowed("C:\\CompanyProjects\\forbidden\\child", baseEnv)).toThrow("PROJECT_PATH_FORBIDDEN");
  });

  it("handles Windows drive letter case insensitivity", () => {
    expect(assertProjectPathAllowed("c:\\CompanyProjects\\my-saas", baseEnv)).toBe("C:\\CompanyProjects\\my-saas");
  });
});
