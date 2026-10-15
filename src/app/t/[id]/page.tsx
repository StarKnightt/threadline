import { Theatre } from "@/components/theatre";

export default async function TracePage({ params }: PageProps<"/t/[id]">) {
  const { id } = await params;
  return <Theatre traceId={id} />;
}
