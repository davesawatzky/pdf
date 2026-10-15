export const annotationTools = {
  highlight: {
    label: "Highlight",
    subtype: "Highlight",
    color: "#fff176",
    instruction: "Drag across an area to highlight it.",
    icon: "m4 15 5 5 11-11-5-5Z M4 15l-2 7 7-2 M12 7l5 5",
  },
  underline: {
    label: "Underline",
    subtype: "Underline",
    color: "#ef5350",
    instruction: "Drag across an area to underline its bottom edge.",
    icon: "M6 3v7a6 6 0 0 0 12 0V3 M4 21h16",
  },
  draw: {
    label: "Draw",
    subtype: "Ink",
    color: "#2196f3",
    instruction: "Drag on a page to draw a freehand stroke.",
    icon: "M3 17c4-12 5 9 9-3s4 8 9-7 M16 3l5 4",
  },
  "sticky-note": {
    label: "Sticky Note",
    subtype: "Text",
    color: "#fff176",
    instruction: "Click on a page to add a sticky note.",
    icon: "M4 3h16v12l-6 6H4Z M14 21v-6h6 M8 8h8 M8 12h5",
  },
} as const;

export type AnnotationTool = keyof typeof annotationTools;

/** Narrow a viewer mode to a supported annotation tool without accepting inherited object keys. */
export function isAnnotationTool(mode: string): mode is AnnotationTool {
  return Object.hasOwn(annotationTools, mode);
}
