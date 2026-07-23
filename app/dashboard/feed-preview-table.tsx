"use client";

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { GoogleAvailability } from "@/lib/product-availability";

export type GooglePriceValue = {
  amountMicros: string;
  currencyCode: string;
};

export type GoogleWeightValue = {
  value: number;
  unit: string;
};

export type GoogleCustomAttribute = {
  name: string;
  value: string;
};

export type FeedPreviewRecord = {
  offerId: string;
  contentLanguage: string;
  feedLabel: string;
  customAttributes?: GoogleCustomAttribute[];
  productAttributes: {
    title: string;
    description: string;
    link: string;
    imageLink: string;
    additionalImageLinks: string[];
    availability: GoogleAvailability;
    availabilityDate: string | null;
    price: GooglePriceValue;
    salePrice: GooglePriceValue | null;
    condition: "NEW";
    googleProductCategory: string | null;
    productTypes: string[];
    ageGroup: string | null;
    color: string | null;
    gender: string | null;
    brand: string | null;
    gtins: string[];
    mpn: string | null;
    identifierExists: boolean;
    itemGroupId: string;
    size: string | null;
    sizeSystem: string | null;
    customLabel0: string | null;
    customLabel1: string | null;
    customLabel2: string | null;
    customLabel3: string | null;
    customLabel4: string | null;
    shippingWeight: GoogleWeightValue | null;
    shippingLabel: string;
    costOfGoodsSold: GooglePriceValue | null;
  };
};

type CellValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | GooglePriceValue
  | GoogleWeightValue
  | string[];

type ColumnDefinition = {
  id: string;
  label: string;
  defaultWidth: number;
  kind?: "imageLink" | "url";
  getValue: (record: FeedPreviewRecord) => CellValue;
};

function getCustomAttributeValue(record: FeedPreviewRecord, name: string) {
  return (
    record.customAttributes?.find((attribute) => attribute.name === name)?.value ??
    null
  );
}

const columns: ColumnDefinition[] = [
  { id: "offerId", label: "offerId", defaultWidth: 200, getValue: (record) => record.offerId },
  {
    id: "contentLanguage",
    label: "contentLanguage",
    defaultWidth: 150,
    getValue: (record) => record.contentLanguage,
  },
  { id: "feedLabel", label: "feedLabel", defaultWidth: 140, getValue: (record) => record.feedLabel },
  {
    id: "customAttributes.variant_id",
    label: "customAttributes.variant_id",
    defaultWidth: 190,
    getValue: (record) => getCustomAttributeValue(record, "variant_id"),
  },
  {
    id: "customAttributes.product_id",
    label: "customAttributes.product_id",
    defaultWidth: 190,
    getValue: (record) => getCustomAttributeValue(record, "product_id"),
  },
  {
    id: "productAttributes.title",
    label: "productAttributes.title",
    defaultWidth: 240,
    getValue: (record) => record.productAttributes.title,
  },
  {
    id: "productAttributes.description",
    label: "productAttributes.description",
    defaultWidth: 360,
    getValue: (record) => record.productAttributes.description,
  },
  {
    id: "productAttributes.link",
    label: "productAttributes.link",
    defaultWidth: 300,
    kind: "url",
    getValue: (record) => record.productAttributes.link,
  },
  {
    id: "productAttributes.imageLink",
    label: "productAttributes.imageLink",
    defaultWidth: 220,
    kind: "imageLink",
    getValue: (record) => record.productAttributes.imageLink,
  },
  {
    id: "productAttributes.additionalImageLinks",
    label: "productAttributes.additionalImageLinks",
    defaultWidth: 280,
    getValue: (record) => record.productAttributes.additionalImageLinks,
  },
  {
    id: "productAttributes.availability",
    label: "productAttributes.availability",
    defaultWidth: 170,
    getValue: (record) => record.productAttributes.availability,
  },
  {
    id: "productAttributes.availabilityDate",
    label: "productAttributes.availabilityDate",
    defaultWidth: 230,
    getValue: (record) => record.productAttributes.availabilityDate,
  },
  {
    id: "productAttributes.price",
    label: "productAttributes.price",
    defaultWidth: 220,
    getValue: (record) => record.productAttributes.price,
  },
  {
    id: "productAttributes.salePrice",
    label: "productAttributes.salePrice",
    defaultWidth: 220,
    getValue: (record) => record.productAttributes.salePrice,
  },
  {
    id: "productAttributes.condition",
    label: "productAttributes.condition",
    defaultWidth: 150,
    getValue: (record) => record.productAttributes.condition,
  },
  {
    id: "productAttributes.googleProductCategory",
    label: "productAttributes.googleProductCategory",
    defaultWidth: 220,
    getValue: (record) => record.productAttributes.googleProductCategory,
  },
  {
    id: "productAttributes.productTypes",
    label: "productAttributes.productTypes",
    defaultWidth: 220,
    getValue: (record) => record.productAttributes.productTypes,
  },
  {
    id: "productAttributes.ageGroup",
    label: "productAttributes.ageGroup",
    defaultWidth: 170,
    getValue: (record) => record.productAttributes.ageGroup,
  },
  {
    id: "productAttributes.color",
    label: "productAttributes.color",
    defaultWidth: 160,
    getValue: (record) => record.productAttributes.color,
  },
  {
    id: "productAttributes.gender",
    label: "productAttributes.gender",
    defaultWidth: 170,
    getValue: (record) => record.productAttributes.gender,
  },
  {
    id: "productAttributes.brand",
    label: "productAttributes.brand",
    defaultWidth: 160,
    getValue: (record) => record.productAttributes.brand,
  },
  {
    id: "productAttributes.gtins",
    label: "productAttributes.gtins",
    defaultWidth: 200,
    getValue: (record) => record.productAttributes.gtins,
  },
  {
    id: "productAttributes.mpn",
    label: "productAttributes.mpn",
    defaultWidth: 160,
    getValue: (record) => record.productAttributes.mpn,
  },
  {
    id: "productAttributes.identifierExists",
    label: "productAttributes.identifierExists",
    defaultWidth: 170,
    getValue: (record) => record.productAttributes.identifierExists,
  },
  {
    id: "productAttributes.itemGroupId",
    label: "productAttributes.itemGroupId",
    defaultWidth: 180,
    getValue: (record) => record.productAttributes.itemGroupId,
  },
  {
    id: "productAttributes.size",
    label: "productAttributes.size",
    defaultWidth: 150,
    getValue: (record) => record.productAttributes.size,
  },
  {
    id: "productAttributes.sizeSystem",
    label: "productAttributes.sizeSystem",
    defaultWidth: 180,
    getValue: (record) => record.productAttributes.sizeSystem,
  },
  {
    id: "productAttributes.customLabel0",
    label: "productAttributes.customLabel0",
    defaultWidth: 160,
    getValue: (record) => record.productAttributes.customLabel0,
  },
  {
    id: "productAttributes.customLabel1",
    label: "productAttributes.customLabel1",
    defaultWidth: 160,
    getValue: (record) => record.productAttributes.customLabel1,
  },
  {
    id: "productAttributes.customLabel2",
    label: "productAttributes.customLabel2",
    defaultWidth: 160,
    getValue: (record) => record.productAttributes.customLabel2,
  },
  {
    id: "productAttributes.customLabel3",
    label: "productAttributes.customLabel3",
    defaultWidth: 160,
    getValue: (record) => record.productAttributes.customLabel3,
  },
  {
    id: "productAttributes.customLabel4",
    label: "productAttributes.customLabel4",
    defaultWidth: 160,
    getValue: (record) => record.productAttributes.customLabel4,
  },
  {
    id: "productAttributes.shippingWeight",
    label: "productAttributes.shippingWeight",
    defaultWidth: 210,
    getValue: (record) => record.productAttributes.shippingWeight,
  },
  {
    id: "productAttributes.shippingLabel",
    label: "productAttributes.shippingLabel",
    defaultWidth: 170,
    getValue: (record) => record.productAttributes.shippingLabel,
  },
  {
    id: "productAttributes.costOfGoodsSold",
    label: "productAttributes.costOfGoodsSold",
    defaultWidth: 240,
    getValue: (record) => record.productAttributes.costOfGoodsSold,
  },
];

const MIN_COLUMN_WIDTH = 100;

function buildDefaultColumnWidths(defaultColumnWidth?: number) {
  return Object.fromEntries(
    columns.map((column) => [
      column.id,
      defaultColumnWidth ?? column.defaultWidth,
    ]),
  ) as Record<string, number>;
}

function stringifyCellValue(value: CellValue) {
  if (value === null || value === undefined) {
    return "";
  }

  if (Array.isArray(value)) {
    return value.join(", ");
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return String(value);
}

function isGooglePriceValue(value: CellValue): value is GooglePriceValue {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "amountMicros" in value &&
      "currencyCode" in value,
  );
}

function isGoogleWeightValue(value: CellValue): value is GoogleWeightValue {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "value" in value &&
      "unit" in value,
  );
}

function formatPriceValue(value: GooglePriceValue) {
  const amount = Number(value.amountMicros) / 1_000_000;

  if (!Number.isFinite(amount)) {
    return stringifyCellValue(value);
  }

  return `${amount.toFixed(2)} ${value.currencyCode}`;
}

function formatWeightValue(value: GoogleWeightValue) {
  const amount = Number.isInteger(value.value)
    ? String(value.value)
    : String(value.value);

  return `${amount} ${value.unit}`;
}

function formatCellValue(value: CellValue) {
  if (isGooglePriceValue(value)) {
    return formatPriceValue(value);
  }

  if (isGoogleWeightValue(value)) {
    return formatWeightValue(value);
  }

  return stringifyCellValue(value);
}

function getCellClassName() {
  return "block w-full overflow-hidden text-ellipsis whitespace-nowrap leading-6 text-muted";
}

export function FeedPreviewTable(props: {
  records: FeedPreviewRecord[];
  emptyMessage: string;
  defaultColumnWidth?: number;
}) {
  const tableViewportRef = useRef<HTMLDivElement | null>(null);
  const resizeStateRef = useRef<{
    key: string;
    startX: number;
    startWidth: number;
  } | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [tableViewportMaxHeight, setTableViewportMaxHeight] = useState(480);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() =>
    buildDefaultColumnWidths(props.defaultColumnWidth),
  );

  useEffect(() => {
    if (!isResizing) {
      return;
    }

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
  }, [isResizing]);

  useEffect(() => {
    let frame = 0;

    function updateTableViewportHeight() {
      const viewport = tableViewportRef.current;

      if (!viewport) {
        return;
      }

      const rect = viewport.getBoundingClientRect();
      const bottomPadding = window.innerWidth >= 1024 ? 32 : 20;
      const availableHeight = Math.floor(
        window.innerHeight - Math.max(rect.top, 0) - bottomPadding,
      );
      const nextHeight = Math.max(280, availableHeight);

      setTableViewportMaxHeight((current) =>
        current === nextHeight ? current : nextHeight,
      );
    }

    function requestUpdate() {
      cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateTableViewportHeight);
    }

    requestUpdate();
    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", requestUpdate);
      window.removeEventListener("resize", requestUpdate);
    };
  }, [props.records.length]);

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      const resizeState = resizeStateRef.current;

      if (!resizeState) {
        return;
      }

      const nextWidth = Math.max(
        MIN_COLUMN_WIDTH,
        resizeState.startWidth + (event.clientX - resizeState.startX),
      );

      setColumnWidths((current) => {
        if (current[resizeState.key] === nextWidth) {
          return current;
        }

        return {
          ...current,
          [resizeState.key]: nextWidth,
        };
      });
    }

    function handlePointerUp() {
      if (!resizeStateRef.current) {
        return;
      }

      resizeStateRef.current = null;
      setIsResizing(false);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, []);

  function startColumnResize(
    key: string,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    event.preventDefault();

    resizeStateRef.current = {
      key,
      startX: event.clientX,
      startWidth: columnWidths[key],
    };
    setIsResizing(true);
  }

  const tableWidth = columns.reduce(
    (sum, column) => sum + columnWidths[column.id],
    0,
  );

  if (!props.records.length) {
    return (
      <div className="rounded-[1.4rem] border border-dashed border-line bg-white/50 p-5 text-sm leading-7 text-muted">
        {props.emptyMessage}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-[1.5rem] border border-line bg-white/70">
      <div
        ref={tableViewportRef}
        className="relative overflow-auto"
        style={{ maxHeight: `${tableViewportMaxHeight}px` }}
      >
        <table
          className="table-fixed text-left text-sm"
          style={{ minWidth: `${tableWidth}px`, width: `${tableWidth}px` }}
        >
          <colgroup>
            {columns.map((column) => (
              <col
                key={column.id}
                style={{
                  minWidth: `${MIN_COLUMN_WIDTH}px`,
                  width: `${columnWidths[column.id]}px`,
                }}
              />
            ))}
          </colgroup>
          <thead className="border-b border-line text-xs uppercase tracking-[0.18em] text-muted">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.id}
                  className="sticky top-0 z-10 border-r border-line/50 bg-white/95 px-4 py-3 pr-6 whitespace-nowrap last:border-r-0"
                  style={{
                    minWidth: `${MIN_COLUMN_WIDTH}px`,
                    width: `${columnWidths[column.id]}px`,
                  }}
                >
                  <span className="block overflow-hidden text-ellipsis whitespace-nowrap">
                    {column.label}
                  </span>
                  <button
                    type="button"
                    aria-label={`Resize ${column.label} column`}
                    onPointerDown={(event) => startColumnResize(column.id, event)}
                    className="absolute top-0 right-0 h-full w-3 translate-x-1/2 cursor-col-resize touch-none"
                  >
                    <span className="absolute inset-y-2 left-1/2 w-px -translate-x-1/2 bg-line" />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.records.map((record) => (
              <tr
                key={record.offerId}
                className="border-b border-line/70 align-top last:border-b-0"
              >
                {columns.map((column) => {
                  const rawValue = column.getValue(record);
                  const value = formatCellValue(rawValue);
                  const rawTitle = stringifyCellValue(rawValue);

                  if (column.kind === "imageLink") {
                    return (
                      <td
                        key={column.id}
                        className="px-4 py-4"
                        style={{
                          minWidth: `${MIN_COLUMN_WIDTH}px`,
                          width: `${columnWidths[column.id]}px`,
                        }}
                      >
                        <div className="grid gap-3">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={value}
                            alt={record.productAttributes.title}
                            className="h-20 w-20 rounded-2xl border border-line object-cover"
                          />
                          <a
                            href={value}
                            target="_blank"
                            rel="noreferrer"
                            title={value}
                            className="block w-full overflow-hidden text-ellipsis whitespace-nowrap text-xs leading-6 text-accent-strong"
                          >
                            {value}
                          </a>
                        </div>
                      </td>
                    );
                  }

                  if (column.kind === "url") {
                    return (
                      <td
                        key={column.id}
                        className="px-4 py-4"
                        style={{
                          minWidth: `${MIN_COLUMN_WIDTH}px`,
                          width: `${columnWidths[column.id]}px`,
                        }}
                      >
                        {value ? (
                          <a
                            href={value}
                            target="_blank"
                            rel="noreferrer"
                            title={value}
                            className="block w-full overflow-hidden text-ellipsis whitespace-nowrap leading-6 text-accent-strong"
                          >
                            {value}
                          </a>
                        ) : (
                          <span className="text-muted">-</span>
                        )}
                      </td>
                    );
                  }

                  return (
                    <td
                      key={column.id}
                      className="px-4 py-4"
                      style={{
                        minWidth: `${MIN_COLUMN_WIDTH}px`,
                        width: `${columnWidths[column.id]}px`,
                      }}
                    >
                      <div className={getCellClassName()} title={rawTitle || value}>
                        {value || "-"}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
