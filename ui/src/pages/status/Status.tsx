import React, { useMemo, useEffect, useRef, useState } from "react";
import {
  Card,
  Typography,
  Button,
  Space,
  Tag,
  Row,
  Col,
  Statistic,
  Progress,
  Skeleton,
  Tooltip,
  message,
} from "antd";
import { useCustom } from "@refinedev/core";
import {
  CopyOutlined,
  CheckOutlined,
  CloudServerOutlined,
  ApiOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";

const { Text, Title } = Typography;

/** Tiny hook to animate numbers without extra deps */
function useCountUp(value: number, ms = 800) {
  const [v, setV] = useState(0);
  const startTs = useRef<number | null>(null);
  const from = useRef(0);

  useEffect(() => {
    let raf = 0;
    startTs.current = null;
    from.current = v;

    const step = (ts: number) => {
      if (!startTs.current) startTs.current = ts;
      const p = Math.min(1, (ts - startTs.current) / ms);
      // Ease-out
      const eased = 1 - Math.pow(1 - p, 3);
      setV(from.current + (value - from.current) * eased);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return Math.round(v);
}

/* ---------------------------- Reusable UI bits --------------------------- */

const CopyChip: React.FC<{
  label: string;
  value?: string;
  tooltip?: string;
  danger?: boolean;
}> = ({ label, value, tooltip, danger }) => {
  const [copied, setCopied] = useState(false);
  const text = value ?? "-";
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      message.error("Copy failed");
    }
  };
  const chip = (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        borderRadius: 10,
        padding: "6px 10px",
        background: danger ? "rgba(244,63,94,0.1)" : "rgba(37,99,235,0.08)",
        border: `1px solid ${danger ? "rgba(244,63,94,0.25)" : "rgba(37,99,235,0.25)"}`,
      }}
    >
      <Text type="secondary" style={{ fontSize: 12 }}>{label}</Text>
      <Text code style={{ fontSize: 12, userSelect: "text" }}>{text}</Text>
      <Button
        size="small"
        type="text"
        onClick={onCopy}
        icon={copied ? <CheckOutlined /> : <CopyOutlined />}
        style={{ padding: "0 4px" }}
      />
    </div>
  );
  return tooltip ? <Tooltip title={tooltip}>{chip}</Tooltip> : chip;
};

const CodeBlock: React.FC<{ code: string; language?: string; copyLabel?: string }> = ({
  code,
  language,
  copyLabel,
}) => {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      message.error("Copy failed");
    }
  };
  return (
    <div
      style={{
        position: "relative",
        background: "#0b1220",
        color: "#e5e7eb",
        borderRadius: 12,
        overflow: "hidden",
        boxShadow: "0 12px 30px rgba(2,6,23,0.35)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          justifyContent: "space-between",
          padding: "8px 12px",
          background: "linear-gradient(90deg, rgba(37,99,235,.25), rgba(99,102,241,.25))",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <Space size={8}>
          <span style={{ width: 8, height: 8, borderRadius: 8, background: "#22c55e" }} />
          <Text style={{ color: "#c7d2fe", fontSize: 12 }}>{language ?? "code"}</Text>
        </Space>
        <Button
          size="small"
          type="text"
          icon={copied ? <CheckOutlined /> : <CopyOutlined />}
          onClick={onCopy}
          style={{ color: "#e5e7eb" }}
        >
          {copied ? "Copied" : copyLabel ?? "Copy"}
        </Button>
      </div>
      <pre style={{ margin: 0, padding: 16, overflowX: "auto", fontSize: 13.5, lineHeight: 1.55 }}>
        <code>{code}</code>
      </pre>
    </div>
  );
};

/* --------------------------------- Page --------------------------------- */

export default function Status() {
  const { data, isLoading, refetch } = useCustom({ url: "/api/status", method: "get" });
  const s = data?.data;

  const collections = s?.collections ?? [];
  const totalEntitiesRaw = useMemo(
    () => collections.reduce((acc: number, c: any) => acc + (c.num_entities || 0), 0),
    [collections],
  );
  const maxEntitiesRaw = useMemo(
    () => Math.max(0, ...collections.map((c: any) => c.num_entities || 0)),
    [collections],
  );

  const totalEntities = useCountUp(totalEntitiesRaw);
  const collectionsCount = useCountUp(collections.length);
  const largestSharePct =
    totalEntitiesRaw > 0 ? Math.round((maxEntitiesRaw / totalEntitiesRaw) * 100) : 0;

  // --------- Derived connection details (copy-ready) ----------
  const host = s?.milvus_host ?? "127.0.0.1";
  const grpcPort = `${s?.milvus_port_grpc ?? "19530"}`;
  const grpcAddress = `${host}:${grpcPort}`;
  const target = s?.target ?? grpcAddress;

  // If server was configured with MILVUS_URI it will appear here (e.g. http/s).
  const isUriTarget = /^https?:\/\//i.test(target);
  const healthUrlGuess = `http://${host}:9091/healthz`; // default mapping used by compose

  const envBlock = [
    `# Copy these to your shell (adjust as needed):`,
    `export MILVUS_HOST="${host}"`,
    `export MILVUS_PORT="${grpcPort}"`,
    isUriTarget ? `export MILVUS_URI="${target}"` : `# export MILVUS_URI="http://${host}:${grpcPort}"  # if using URI`,
    `# export MILVUS_SECURE=true              # set true if TLS is enabled`,
    `# export MILVUS_DB="<default>"           # set if using named DB`,
    `# export MILVUS_USER="<username>"        # optional`,
    `# export MILVUS_PASSWORD="<password>"    # optional`,
  ].join("\n");

  const pyMilvusSnippet = [
    `from pymilvus import connections`,
    ``,
    isUriTarget
      ? `# Connect via URI (auto-detects scheme).`
      : `# Connect via host/port.`,
    isUriTarget
      ? `connections.connect(alias="default", uri="${target}", timeout=60)`
      : `connections.connect(alias="default", host="${host}", port="${grpcPort}", secure=False, timeout=60)`,
    `# If you use auth or named DB:`,
    `# connections.connect(alias="default", host="${host}", port="${grpcPort}", user="<user>", password="<password>", db_name="<default>", secure=False)`,
    ``,
    `# Now you can use Collection("...") and run searches.`,
  ].join("\n");

  const copyAll = async () => {
    const all = `${envBlock}\n\n# PyMilvus connect example\n${pyMilvusSnippet}\n`;
    try {
      await navigator.clipboard.writeText(all);
      message.success("Connection details copied");
    } catch {
      message.error("Copy failed");
    }
  };

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={16}>
          <Card
            title={
              <Space size={8}>
                <span
                  style={{
                    display: "inline-block",
                    width: 10,
                    height: 10,
                    borderRadius: 6,
                    background: "#2563eb",
                  }}
                />
                <span>Milvus Status</span>
              </Space>
            }
            extra={
              <Button
                loading={isLoading}
                onClick={() => refetch()}
                type="primary"
                icon={<ThunderboltOutlined />}
                style={{ transition: "transform 0.2s" }}
                onMouseEnter={(e) => ((e.currentTarget.style.transform = "translateY(-1px)"))}
                onMouseLeave={(e) => ((e.currentTarget.style.transform = "translateY(0)"))}
              >
                Refresh
              </Button>
            }
            styles={{ body: { paddingTop: 14 } }}
          >
            {isLoading ? (
              <Skeleton active paragraph={{ rows: 3 }} />
            ) : (
              <Row gutter={[12, 12]}>
                <Col span={24}>
                  <Space direction="vertical" size="small" style={{ width: "100%" }}>
                    <div>
                      <Text strong>Target:</Text>{" "}
                      <Text code>{target}</Text>
                    </div>
                    <div>
                      <Text strong>Server Version:</Text>{" "}
                      {s?.server_version ?? "-"}
                    </div>
                    <div>
                      <Text strong>gRPC:</Text>{" "}
                      {host}:{grpcPort}
                    </div>
                    <div>
                      <Text strong>Health (9091):</Text>{" "}
                      {s?.milvus_healthz_http === true ? (
                        <Tag color="green">healthy</Tag>
                      ) : s?.milvus_healthz_http === false ? (
                        <Tag color="red">unhealthy</Tag>
                      ) : (
                        <Tag>unknown</Tag>
                      )}
                    </div>
                  </Space>
                </Col>
              </Row>
            )}
          </Card>
        </Col>

        <Col xs={24} lg={8}>
          <Card title="Overview" extra={<ApiOutlined />}>
            {isLoading ? (
              <Skeleton active />
            ) : (
              <Row gutter={[12, 12]}>
                <Col span={12}>
                  <Statistic
                    title="Collections"
                    value={collectionsCount}
                    valueStyle={{ transition: "color 0.3s" }}
                  />
                </Col>
                <Col span={12}>
                  <Statistic
                    title="Total Entities"
                    value={totalEntities}
                    valueStyle={{ transition: "color 0.3s" }}
                  />
                </Col>
                <Col span={24} style={{ marginTop: 8 }}>
                  <Text type="secondary">Largest collection share</Text>
                  <Progress percent={largestSharePct} status="active" />
                </Col>
              </Row>
            )}
          </Card>
        </Col>
      </Row>

      {/* ----------- New: Connection details for copy/paste ----------- */}
      <Card
        title={
          <Space>
            <CloudServerOutlined />
            <span>Connection details (copy & paste)</span>
          </Space>
        }
        extra={
          <Button onClick={copyAll} icon={<CopyOutlined />}>
            Copy all
          </Button>
        }
      >
        {isLoading ? (
          <Skeleton active paragraph={{ rows: 3 }} />
        ) : (
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Space wrap size={[8, 8]}>
              <CopyChip label="gRPC address" value={grpcAddress} tooltip="Use in SDKs and clients" />
              <CopyChip
                label="Target"
                value={target}
                tooltip="MILVUS_URI or host:port"
              />
              <CopyChip
                label="Health URL"
                value={healthUrlGuess}
                tooltip="Default health endpoint (adjust if different)"
              />
            </Space>

            <Row gutter={[16, 16]}>
              <Col xs={24} md={12}>
                <Text strong>ENV exports</Text>
                <CodeBlock code={envBlock} language="bash" copyLabel="Copy ENV" />
              </Col>
              <Col xs={24} md={12}>
                <Text strong>PyMilvus connect</Text>
                <CodeBlock code={pyMilvusSnippet} language="python" copyLabel="Copy Python" />
              </Col>
            </Row>
          </Space>
        )}
      </Card>

      <Card title="Collections">
        {isLoading ? (
          <Skeleton active paragraph={{ rows: 4 }} />
        ) : collections.length === 0 ? (
          <Text type="secondary">No collections yet.</Text>
        ) : (
          <Row gutter={[16, 16]}>
            {collections.map((c: any) => {
              const pctOfMax =
                maxEntitiesRaw > 0 ? Math.round(((c.num_entities || 0) / maxEntitiesRaw) * 100) : 0;
              const pctOfTotal =
                totalEntitiesRaw > 0 ? Math.round(((c.num_entities || 0) / totalEntitiesRaw) * 100) : 0;

              return (
                <Col xs={24} md={12} lg={8} key={c.name}>
                  <Card
                    hoverable
                    style={{
                      transition: "transform 0.18s ease, box-shadow 0.18s ease",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget.style.transform = "translateY(-2px)");
                      (e.currentTarget.style.boxShadow = "0 10px 24px rgba(0,0,0,0.08)");
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget.style.transform = "translateY(0)");
                      (e.currentTarget.style.boxShadow = "");
                    }}
                    title={<Title level={5} style={{ margin: 0 }}>{c.name}</Title>}
                  >
                    <Space direction="vertical" style={{ width: "100%" }}>
                      <Space split={<span>•</span>} wrap>
                        <Text type="secondary">
                          Entities: <Text strong>{c.num_entities ?? 0}</Text>
                        </Text>
                        <Text type="secondary">
                          Share: <Text strong>{pctOfTotal}%</Text>
                        </Text>
                      </Space>

                      <div>
                        {(c.fields ?? []).map((f: any, i: number) => (
                          <Tag key={i} style={{ marginBottom: 6 }}>
                            {f.name}:{String(f.dtype).replace("DataType.", "")}
                            {f.dim ? `[${f.dim}]` : ""}{f.primary_key ? " (PK)" : ""}
                          </Tag>
                        ))}
                      </div>

                      <div>
                        {(c.indexes ?? []).length ? (
                          (c.indexes ?? []).map((i: any, k: number) => (
                            <Tag key={k} color="blue" style={{ marginBottom: 6 }}>
                              {i.field} · {i.index_type}/{i.metric_type}
                            </Tag>
                          ))
                        ) : (
                          <Tag>no indexes</Tag>
                        )}
                      </div>

                      <Tooltip title="Fill vs. largest collection">
                        <Progress percent={pctOfMax} size="small" status="active" />
                      </Tooltip>
                    </Space>
                  </Card>
                </Col>
              );
            })}
          </Row>
        )}
      </Card>
    </Space>
  );
}
