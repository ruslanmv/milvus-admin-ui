import React from "react";
import { Card, Typography } from "antd";
import CreateCollectionWizard from "./components/CreateCollectionWizard";

const { Title, Paragraph } = Typography;

/**
 * Standalone route version of the Create Collection Wizard
 * (useful if you navigate to /collections/create).
 */
export default function CollectionsCreate() {
  return (
    <div style={{ maxWidth: 1040, margin: "0 auto" }}>
      <Card
        style={{ borderRadius: 12, border: "1px solid rgba(0,0,0,0.06)", marginBottom: 12 }}
        bodyStyle={{ padding: 16 }}
      >
        <Title level={5} style={{ margin: 0 }}>
          Create a new collection
        </Title>
        <Paragraph type="secondary" style={{ margin: 0 }}>
          Follow the step-by-step wizard to configure schema & index, pick your data source (Local, HTTP, S3, IBM COS),
          set ingest options, and optionally trigger an ingest.
        </Paragraph>
      </Card>

      <CreateCollectionWizard standalone />
    </div>
  );
}
