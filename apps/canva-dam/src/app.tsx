// Etsy Product Ideas — Canva DAM App
// Shows AI-generated product concepts from the daily automation research.
// Users can browse ideas, drag them into Canva designs, and export to Etsy.
import { SearchableListView } from "@canva/app-components";
import { Box } from "@canva/app-ui-kit";
import "@canva/app-ui-kit/styles.css";
import { useConfig } from "./config";
import { findResources } from "./adapter";
import * as styles from "./index.css";

export function App() {
  const config = useConfig();
  return (
    <Box className={styles.rootWrapper} height="full">
      {/*
        SearchableListView renders the full DAM panel: search, filters, folders,
        and an asset grid. findResources is called every time the user searches,
        navigates a folder, or changes filters.
      */}
      <SearchableListView config={config} findResources={findResources} />
    </Box>
  );
}
