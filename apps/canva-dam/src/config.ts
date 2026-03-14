// SearchableListView configuration for the Etsy Product Ideas DAM app.
// Containers (folders) = research dates. Assets = AI-generated product concepts.
import type { Config } from "@canva/app-components";
import { useIntl } from "react-intl";

type ContainerTypes = "date_folder";

export const useConfig = (): Config<ContainerTypes> => {
  const intl = useIntl();

  return {
    serviceName: intl.formatMessage({
      defaultMessage: "Etsy Product Ideas",
      description: "Name of the service shown in the DAM panel header",
    }),

    search: {
      enabled: true,
      filterFormConfig: {
        containerTypes: ["date_folder"],
        filters: [
          {
            filterType: "CHECKBOX",
            label: intl.formatMessage({
              defaultMessage: "Category",
              description: "Filter label for product category",
            }),
            key: "category",
            options: [
              { value: "Printable Wall Art",  label: "Printable Wall Art" },
              { value: "SVG Cut Files",        label: "SVG Cut Files" },
              { value: "Digital Planner",      label: "Digital Planner" },
              { value: "Canva Template",       label: "Canva Template" },
              { value: "Party Printables",     label: "Party Printables" },
              { value: "Resume Template",      label: "Resume Template" },
            ],
            allowCustomValue: true,
          },
          {
            filterType: "RADIO",
            label: intl.formatMessage({
              defaultMessage: "Trend Score",
              description: "Filter label for AI-predicted trend score",
            }),
            key: "trendScore",
            options: [
              {
                value: "high",
                label: intl.formatMessage({
                  defaultMessage: "High (8–10)",
                  description: "High trend score filter option",
                }),
              },
              {
                value: "medium",
                label: intl.formatMessage({
                  defaultMessage: "Medium (5–7)",
                  description: "Medium trend score filter option",
                }),
              },
            ],
            allowCustomValue: false,
          },
        ],
      },
    },

    containerTypes: [
      {
        value: "date_folder",
        label: intl.formatMessage({
          defaultMessage: "Research Dates",
          description: "Name for folders that group products by research date",
        }),
        listingSurfaces: [
          { surface: "HOMEPAGE" },
          {
            surface: "CONTAINER",
            parentContainerTypes: ["date_folder"],
          },
          { surface: "SEARCH" },
        ],
        searchInsideContainer: {
          enabled: true,
          placeholder: intl.formatMessage({
            defaultMessage: "Search products from this date",
            description: "Placeholder for folder-level search input",
          }),
        },
      },
    ],

    sortOptions: [
      {
        value: "trend_score DESC",
        label: intl.formatMessage({
          defaultMessage: "Trend Score (highest)",
          description: "Sort by AI trend score descending",
        }),
      },
      {
        value: "trend_score ASC",
        label: intl.formatMessage({
          defaultMessage: "Trend Score (lowest)",
          description: "Sort by AI trend score ascending",
        }),
      },
      {
        value: "date DESC",
        label: intl.formatMessage({
          defaultMessage: "Date (newest)",
          description: "Sort by research date descending",
        }),
      },
      {
        value: "date ASC",
        label: intl.formatMessage({
          defaultMessage: "Date (oldest)",
          description: "Sort by research date ascending",
        }),
      },
    ],

    layouts: ["MASONRY", "LIST"],
    resourceTypes: ["IMAGE"],

    moreInfoMessage: intl.formatMessage({
      defaultMessage:
        "Showing AI-generated product concepts. Click any concept to add its thumbnail to your design. The daily automation runs at 09:00 UTC.",
      description: "Helper text shown in the panel info area",
    }),
  };
};
