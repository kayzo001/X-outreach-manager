import { prisma } from "@/lib/db";
import { ImportWizard } from "@/components/import-wizard";
import { Card, CardHeader, PageHeader, StatusBadge, Table, Td, Th } from "@/components/ui";
import { dt } from "@/lib/utils";

export default async function ImportPage() {
  const [campaigns, imports] = await Promise.all([
    prisma.campaign.findMany({ where: { status: { not: "ARCHIVED" } }, select: { id: true, name: true }, orderBy: { createdAt: "desc" } }),
    prisma.csvImport.findMany({ orderBy: { createdAt: "desc" }, take: 15 }),
  ]);
  return (
    <>
      <PageHeader title="Import leads" desc="Upload a CSV or XLSX of X usernames. Duplicates are detected within the file and against everything already stored; existing contact history is never overwritten." />
      <ImportWizard campaigns={campaigns} />
      <Card className="mt-8" id="history">
        <CardHeader title="Import history" />
        <Table><thead><tr><Th>File</Th><Th>When</Th><Th>Rows</Th><Th>New</Th><Th>Existing</Th><Th>Rejected</Th><Th>Status</Th></tr></thead>
          <tbody>{imports.map((i) => <tr key={i.id}><Td className="font-medium">{i.filename}</Td><Td className="text-muted-foreground">{dt(i.createdAt)}</Td><Td>{i.totalRows}</Td><Td>{i.newRows}</Td><Td>{i.existingRows}</Td><Td>{i.invalidRows + i.dupInFileRows}</Td><Td><StatusBadge s={i.status} /></Td></tr>)}
            {!imports.length && <tr><Td colSpan={7} className="py-8 text-center text-muted-foreground">No imports yet.</Td></tr>}</tbody></Table>
      </Card>
    </>
  );
}
