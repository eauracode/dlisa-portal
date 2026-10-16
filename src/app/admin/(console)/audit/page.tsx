import type { Metadata } from "next";
import { pool } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/current";
import { getAuditLog } from "@/lib/services/admin/overview";
import { formatDateTime } from "@/lib/format";
import { PageHeader, Table, Td, Th } from "@/components/ui";

export const metadata: Metadata = { title: "Audit log" };

export default async function AuditPage() {
  const admin = await requireAdmin("audit.view");
  const log = await getAuditLog(pool(), admin);
  return (
    <>
      <PageHeader title="Audit log" description="The most recent 200 security and administrative events. Entries never contain PINs, passwords, tokens or complaint text." />
      <Table>
        <thead>
          <tr>
            <Th>When</Th>
            <Th>Actor</Th>
            <Th>Action</Th>
            <Th>Record</Th>
            <Th>Details</Th>
          </tr>
        </thead>
        <tbody>
          {log.map((l) => (
            <tr key={l.id}>
              <Td className="whitespace-nowrap text-xs">{formatDateTime(l.created_at)}</Td>
              <Td className="text-sm">{l.actor ?? l.actor_type}</Td>
              <Td className="font-mono text-xs">{l.action}</Td>
              <Td className="font-mono text-xs">
                {l.entity_type} {l.entity_id?.slice(0, 8)}
              </Td>
              <Td className="max-w-xs truncate font-mono text-xs text-muted">{Object.keys(l.metadata).length ? JSON.stringify(l.metadata) : ""}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}
