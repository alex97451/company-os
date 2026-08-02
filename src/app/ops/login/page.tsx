import { OpsLogin } from "@/components/ops-login";
import { opsAuthConfigured } from "@/lib/ops/auth";

export default function OpsLoginPage() {
  return <OpsLogin configured={opsAuthConfigured()} />;
}
