import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTable, List, DeleteButton } from "@refinedev/antd";
import { useCustom, useCustomMutation } from "@refinedev/core";
import {
  Table,
  Tag,
  Space,
  Button,
  Typography,
  Alert,
  Tooltip,
  Drawer,
  Tabs,
  Descriptions,
  Row,
  Col,
  Modal,
  Dropdown,
  Card,
  Divider,
} from "antd";
import {
  ReloadOutlined,
  DatabaseOutlined,
  SearchOutlined,
  ImportOutlined,
  DeploymentUnitOutlined,
  InboxOutlined,
  ExportOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  EyeOutlined,
  PlusOutlined,
  MoreOutlined,
  InfoCircleOutlined,
  AppstoreAddOutlined,
  CloudUploadOutlined, // NEW
} from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import CreateCollectionWizard from "./components/CreateCollectionWizard";
import AddDataWizard from "./components/AddDataWizard"; // NEW

const { Text, Title, Paragraph } = Typography;

/** Derive quick status from known fields (best-effort without extra APIs). */
function computeStatus(rec: any): { label: string; color: string } {
  const hasIndex = (rec.indexes ?? []).length > 0;
  const ents = rec.num_entities ?? 0;

  if (hasIndex && ents > 0) return { label: "Ready", color: "green" };
  if (hasIndex) return { label: "Indexing", color: "blue" };
  if (ents > 0) return { label: "Loaded", color: "gold" }; // heuristic
  return { label: "Empty", color: "default" };
}

/** First vector field dim + index metric/type summaries */
function deriveDims(rec: any): { dim?: number; metric?: string; indexType?: string } {
  const vf = (rec.fields ?? []).find((f: any) => String(f.dtype).includes("FLOAT_VECTOR"));
  const dim = vf?.dim;
  const idx0 = (rec.indexes ?? [])[0];
  const metric = idx0?.metric_type;
  const indexType = idx0?.index_type;
  return { dim, metric, indexType };
}

/** Safe string for unknowns */
const dash = (v: any) => (v === null || v === undefined || v === "" ? "—" : v);

/** Pretty section title */
const SectionTitle: React.FC<{ icon?: React.ReactNode; children: React.ReactNode }> = ({
  icon,
  children,
}) => (
  <Space>
    {icon}
    <Title level={5} style={{ margin: 0 }}>
      {children}
    </Title>
  </Space>
);

/** Details Drawer — tabs per spec */
const CollectionDetails: React.FC<{
  name: string;
  open: boolean;
  onClose: () => void;
}> = ({ name, open, onClose }) => {
  const { data, isLoading } = useCustom({
    url: `/api/collections/${encodeURIComponent(name)}`,
    method: "get",
  });
  const info = data?.data;

  const schemaFields = info?.fields ?? [];
  const idxs = info?.indexes ?? [];

  return (
    <Drawer
      title={<SectionTitle icon={<DatabaseOutlined />}>{name}</SectionTitle>}
      placement="right"
      width={900}
      open={open}
      onClose={onClose}
      styles={{ body: { paddingTop: 0 } }}
    >
      <Tabs
        items={[
          {
            key: "schema",
            label: "Schema",
            children: (
              <>
                <Descriptions title="Overview" bordered column={2} style={{ marginBottom: 16 }} size="small">
                  <Descriptions.Item label="Entities">{dash(info?.num_entities)}</Descriptions.Item>
                  <Descriptions.Item label="Vector field">{dash(info?.schema_info?.vector_field)}</Descriptions.Item>
                  <Descriptions.Item label="ID (PK)">{dash(info?.schema_info?.id_field)}</Descriptions.Item>
                  <Descriptions.Item label="Default output fields">
                    {dash((info?.schema_info?.default_output_fields ?? []).join(", "))}
                  </Descriptions.Item>
                </Descriptions>

                <SectionTitle>Fields</SectionTitle>
                <Table
                  size="small"
                  loading={isLoading}
                  rowKey={(r) => r.name}
                  pagination={false}
                  style={{ marginTop: 8 }}
                  dataSource={schemaFields}
                  columns={[
                    { title: "Name", dataIndex: "name" },
                    {
                      title: "Type",
                      dataIndex: "dtype",
                      render: (v: string) => String(v).replace("DataType.", ""),
                    },
                    {
                      title: "Dim",
                      dataIndex: "dim",
                      render: (v: any) => (v ? v : "—"),
                      width: 90,
                    },
                    {
                      title: "Primary",
                      width: 90,
                      render: (_: any, r: any) =>
                        r.primary_key ? <Tag color="green">PK</Tag> : <Tag>—</Tag>,
                    },
                    {
                      title: "Max length",
                      dataIndex: "max_length",
                      render: (v: any) => dash(v),
                      width: 120,
                    },
                  ]}
                />
                <Alert
                  type="info"
                  showIcon
                  style={{ marginTop: 12 }}
                  message="Guardrails"
                  description="Illegal schema mutations (e.g., changing the dim of an existing vector field) are disallowed in Milvus and would require a new collection and reindex."
                />
              </>
            ),
          },
          {
            key: "indexes",
            label: "Indexes",
            children: (
              <>
                <Table
                  size="small"
                  loading={isLoading}
                  rowKey={(_, i) => String(i)}
                  pagination={false}
                  dataSource={idxs}
                  columns={[
                    { title: "Field", dataIndex: "field" },
                    { title: "Type", dataIndex: "index_type" },
                    { title: "Metric", dataIndex: "metric_type" },
                    {
                      title: "Params",
                      dataIndex: "params",
                      render: (p: any) => <code>{JSON.stringify(p ?? {}, null, 0)}</code>,
                    },
                  ]}
                />
                <Space style={{ marginTop: 12 }}>
                  <Button icon={<DeploymentUnitOutlined />} disabled>
                    Build index
                  </Button>
                  <Button danger disabled>
                    Drop index
                  </Button>
                </Space>
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginTop: 12 }}
                  message="Create/Drop index"
                  description="Index management (HNSW, IVF_FLAT, IVF_PQ, DiskANN) with parameter validation and progress will appear here."
                />
              </>
            ),
          },
          {
            key: "load",
            label: "Load & replicas",
            children: (
              <>
                <Space style={{ marginBottom: 12 }}>
                  <Button disabled>Load</Button>
                  <Button disabled>Release</Button>
                </Space>
                <Descriptions bordered size="small" column={2}>
                  <Descriptions.Item label="Replica count">—</Descriptions.Item>
                  <Descriptions.Item label="Memory estimate">—</Descriptions.Item>
                </Descriptions>
                <Alert
                  type="info"
                  showIcon
                  style={{ marginTop: 12 }}
                  message="Coming soon"
                  description="Set replica count and view capacity hints (mem estimate) once server endpoints are wired."
                />
              </>
            ),
          },
          {
            key: "ingest",
            label: "Ingest / Sync",
            children: (
              <>
                <Alert
                  type="success"
                  showIcon
                  message="Use the global Sync"
                  description="Use 'Sync documents' from Collections list to ingest from ./data and rebuild your Milvus collections."
                  style={{ borderRadius: 10 }}
                />
                <Descriptions title="Schema mapping (typical)" bordered size="small" column={1} style={{ marginTop: 12 }}>
                  <Descriptions.Item label="doc_id">string</Descriptions.Item>
                  <Descriptions.Item label="title">string (optional)</Descriptions.Item>
                  <Descriptions.Item label="content/text">string</Descriptions.Item>
                  <Descriptions.Item label="metadata">JSON</Descriptions.Item>
                  <Descriptions.Item label="tags">string[]</Descriptions.Item>
                  <Descriptions.Item label="partition">string</Descriptions.Item>
                  <Descriptions.Item label="embedding">float[dim]</Descriptions.Item>
                </Descriptions>
              </>
            ),
          },
          {
            key: "documents",
            label: "Documents",
            children: (
              <Alert
                type="info"
                showIcon
                message="Open in RAG"
                description="Use the RAG page to run keyword + vector search, then edit/re-embed specific chunks."
              />
            ),
          },
          {
            key: "jobs",
            label: "Jobs",
            children: (
              <Alert
                type="info"
                showIcon
                message="Jobs dashboard"
                description="Index builds, imports, compactions, backups with status and logs will appear here."
              />
            ),
          },
          {
            key: "monitoring",
            label: "Monitoring",
            children: (
              <Alert
                type="info"
                showIcon
                message="Monitoring"
                description="QPS, latency p50/p95/p99, memory, segments, compaction stats, node health — coming soon."
              />
            ),
          },
          {
            key: "backups",
            label: "Backups & export",
            children: (
              <Alert
                type="info"
                showIcon
                message="Snapshots & exports"
                description="Snapshot/restore, export Parquet/JSONL (with/without vectors) — coming soon."
              />
            ),
          },
          {
            key: "access",
            label: "Access & safety",
            children: (
              <Alert
                type="warning"
                showIcon
                message="Access control & safety"
                description="Roles/keys, consistency level, flush & manual compaction, and a Danger Zone for irreversible actions."
              />
            ),
          },
        ]}
      />
    </Drawer>
  );
};

export default function CollectionsList() {
  const navigate = useNavigate();

  const { tableProps, tableQueryResult } = useTable({
    resource: "collections",
    pagination: { mode: "off" },
  });
  const rawRows: any[] = (tableProps?.dataSource as any[]) || [];

  // Enrich rows for computed columns
  const rows = useMemo(
    () =>
      rawRows.map((r) => {
        const { dim, metric, indexType } = deriveDims(r);
        return {
          ...r,
          _status: computeStatus(r),
          _dim: dim,
          _metric: metric,
          _indexType: indexType,
          _partitions: r.partitions?.length ?? r.partition_num ?? "—",
          _size: r.size_bytes ?? "—",
          _replicas: r.replicas ?? "—",
          _updated_at: r.updated_at ?? "—",
        };
      }),
    [rawRows],
  );

  const { mutateAsync, isLoading } = useCustomMutation();

  // Success banner (animated)
  const [showSuccess, setShowSuccess] = useState(false);
  const hideTimerRef = useRef<number | null>(null);
  useEffect(() => () => hideTimerRef.current && window.clearTimeout(hideTimerRef.current), []);

  const onSync = async () => {
    try {
      await mutateAsync({
        url: "/api/sync",
        method: "post",
        errorNotification: (err) => ({
          message: "Sync failed",
          description: (err as any)?.response?.data?.detail || String(err),
          type: "error",
        }),
      });
      setShowSuccess(true);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = window.setTimeout(() => setShowSuccess(false), 6000);
      await tableQueryResult?.refetch?.();
    } catch {
      /* handled via errorNotification */
    }
  };

  const onRefresh = async () => {
    await tableQueryResult?.refetch?.();
  };

  // Action handlers (stubs for now)
  const notYet = (title: string) =>
    Modal.info({
      icon: <ExclamationCircleOutlined />,
      title,
      content: "This action will be available once backend endpoints are added.",
    });

  // Create wizard state
  const [createOpen, setCreateOpen] = useState(false);

  // Add Data wizard state (NEW)
  const [addOpen, setAddOpen] = useState<{ open: boolean; collection?: string }>({
    open: false,
    collection: undefined,
  });

  // Table columns
  const columns = [
    {
      title: "Name",
      dataIndex: "id",
      fixed: "left" as const,
      width: 320,
      render: (v: string, rec: any) => {
        const dim = (rec.fields || []).find((f: any) => String(f.dtype).includes("FLOAT_VECTOR"))?.dim ?? "—";
        return (
          <div style={{ minWidth: 0 }}>
            <Tooltip title={v}>
              <Text strong ellipsis style={{ maxWidth: 260, display: "inline-block", verticalAlign: "middle" }}>
                {v}
              </Text>
            </Tooltip>
            <Tag style={{ marginLeft: 8 }}>{dim}D</Tag>
          </div>
        );
      },
    },
    {
      title: "Status",
      dataIndex: "_status",
      width: 130,
      render: (s: any) => <Tag color={s?.color || "default"}>{s?.label || "—"}</Tag>,
    },
    {
      title: "Entities",
      dataIndex: "num_entities",
      width: 140,
      render: (v: number) => <Text strong>{v ?? 0}</Text>,
      sorter: (a: any, b: any) => (a.num_entities ?? 0) - (b.num_entities ?? 0),
    },
    {
      title: "Dim / Metric",
      width: 180,
      render: (_: any, r: any) => (
        <span>
          {dash(r._dim)} / <Text type="secondary">{dash(r._metric)}</Text>
        </span>
      ),
      responsive: ["md"],
    },
    {
      title: "Index type",
      dataIndex: "_indexType",
      width: 150,
      render: (v: string) => dash(v),
      responsive: ["md"],
    },
    {
      title: "Partitions",
      dataIndex: "_partitions",
      width: 130,
      render: (v: any) => dash(v),
      responsive: ["lg"],
    },
    {
      title: "Size",
      dataIndex: "_size",
      width: 130,
      render: (v: any) => (typeof v === "number" ? `${(v / (1024 * 1024)).toFixed(1)} MB` : dash(v)),
      responsive: ["lg"],
    },
    {
      title: "Replicas",
      dataIndex: "_replicas",
      width: 120,
      render: (v: any) => dash(v),
      responsive: ["lg"],
    },
    {
      title: "Last updated",
      dataIndex: "_updated_at",
      width: 200,
      render: (v: any) => dash(v),
      responsive: ["xl"],
    },
    {
      title: "Actions",
      dataIndex: "actions",
      width: 420, // widened a bit to fit the new button
      render: (_: any, record: any) => {
        const menuItems = [
          {
            key: "build",
            label: "Build index",
            icon: <DeploymentUnitOutlined />,
            onClick: () => notYet("Build index"),
          },
          {
            key: "dropidx",
            label: "Drop index",
            danger: true,
            onClick: () => notYet("Drop index"),
          },
          { type: "divider" as const },
          { key: "load", label: "Load", onClick: () => notYet("Load collection") },
          { key: "release", label: "Release", onClick: () => notYet("Release collection") },
          { type: "divider" as const },
          {
            key: "backup",
            label: "Backup/Export",
            icon: <ExportOutlined />,
            onClick: () => notYet("Backup & export"),
          },
          {
            key: "rename",
            label: "Rename",
            icon: <EditOutlined />,
            onClick: () => notYet("Rename collection"),
          },
        ];
        return (
          <Space wrap>
            <Button size="small" icon={<EyeOutlined />} onClick={() => setDetails({ open: true, name: record.id })}>
              View
            </Button>
            <Button
              size="small"
              icon={<SearchOutlined />}
              onClick={() => navigate("/rag", { state: { collection: record.id } })}
            >
              Query
            </Button>
            <Button
              size="small"
              icon={<PlusOutlined />}
              onClick={() => navigate("/rag", { state: { tab: "insert", collection: record.id } })}
            >
              Insert
            </Button>

            {/* NEW: Add data (opens upload wizard for this existing collection) */}
            <Button
              size="small"
              icon={<CloudUploadOutlined />}
              onClick={() => setAddOpen({ open: true, collection: record.id })}
            >
              Add data
            </Button>

            <Button size="small" icon={<ImportOutlined />} onClick={onSync} loading={isLoading}>
              Import
            </Button>
            <Dropdown menu={{ items: menuItems }} trigger={["click"]}>
              <Button size="small" icon={<MoreOutlined />} />
            </Dropdown>
            <DeleteButton
              size="small"
              resource="collections"
              recordItemId={record.id}
              confirmTitle={`Drop collection "${record.id}"?`}
              confirmOkText="Drop"
            />
          </Space>
        );
      },
    },
  ] as any;

  // Details drawer state
  const [details, setDetails] = useState<{ open: boolean; name?: string }>({ open: false });

  const headerButtons = (
    <Space wrap>
      <Button type="primary" icon={<AppstoreAddOutlined />} onClick={() => setCreateOpen(true)}>
        New Collection
      </Button>
      <Button icon={<ReloadOutlined />} onClick={onRefresh}>
        Refresh
      </Button>
      <Button icon={<InboxOutlined />} loading={isLoading} onClick={onSync}>
        Sync documents
      </Button>
    </Space>
  );

  return (
    <>
      {/* Enterprise-style intro card */}
      <Card
        style={{
          borderRadius: 12,
          border: "1px solid rgba(0,0,0,0.06)",
          marginBottom: 12,
        }}
        bodyStyle={{ padding: 16 }}
      >
        <Row align="middle" gutter={[12, 12]}>
          <Col flex="none">
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                background: "#eef2ff",
                display: "grid",
                placeItems: "center",
              }}
            >
              <InfoCircleOutlined style={{ color: "#4f46e5", fontSize: 18 }} />
            </div>
          </Col>
          <Col flex="auto">
            <Title level={5} style={{ margin: 0 }}>
              Collections
            </Title>
            <Paragraph type="secondary" style={{ margin: 0 }}>
              Create, sync, index and explore your Milvus datasets. Use <strong>View</strong> for schema & indexes,
              <strong> Query</strong> to open RAG, <strong>Insert</strong> for quick docs,{" "}
              <strong>Add data</strong> to upload more files to an existing collection, and{" "}
              <strong>Import</strong> to run your ingest pipeline.
            </Paragraph>
          </Col>
          <Col flex="none">{headerButtons}</Col>
        </Row>
      </Card>

      {/* Green success box (animated) */}
      <div
        style={{
          opacity: showSuccess ? 1 : 0,
          transform: showSuccess ? "translateY(0)" : "translateY(-6px)",
          transition: "opacity .3s ease, transform .3s ease",
          marginBottom: showSuccess ? 12 : 0,
        }}
      >
        <Alert
          type="success"
          showIcon
          closable
          onClose={() => setShowSuccess(false)}
          message={<strong>Sync complete</strong>}
          description="Documents ingested and Milvus collections updated."
          style={{
            borderRadius: 10,
            boxShadow: "0 8px 24px rgba(16,185,129,0.18)",
          }}
        />
      </div>

      <List title={null} headerButtons={null}>
        <Table
          {...tableProps}
          dataSource={rows}
          rowKey="id"
          columns={columns}
          pagination={false}
          size="middle"
          sticky
          scroll={{ x: 1300 }}
          style={{ transition: "opacity 0.2s" }}
        />
      </List>

      {/* Details Drawer */}
      {details.open && details.name && (
        <CollectionDetails
          name={details.name}
          open={details.open}
          onClose={() => setDetails({ open: false })}
        />
      )}

      {/* Create Collection Wizard (modal) */}
      {createOpen && (
        <CreateCollectionWizard
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={async () => {
            await tableQueryResult?.refetch?.();
          }}
        />
      )}

      {/* NEW: Add Data Wizard (modal) */}
      {addOpen.open && addOpen.collection && (
        <AddDataWizard
          open={addOpen.open}
          collection={addOpen.collection}
          onClose={() => setAddOpen({ open: false, collection: undefined })}
          onDone={async () => {
            await tableQueryResult?.refetch?.();
          }}
        />
      )}
    </>
  );
}
