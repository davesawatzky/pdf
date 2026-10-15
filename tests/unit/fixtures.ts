import { PDFDocument } from "pdf-lib";

export async function makeDoc(count = 3): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) doc.addPage([300 + i * 10, 200 + i * 10]);
  return doc;
}

export async function makeFormDoc(): Promise<PDFDocument> {
  const doc = await makeDoc(2);
  const form = doc.getForm();
  const text = form.createTextField("Name");
  text.addToPage(doc.getPage(0));
  const checkbox = form.createCheckBox("Agree");
  checkbox.addToPage(doc.getPage(0));
  const dropdown = form.createDropdown("Country");
  dropdown.addOptions(["US", "DE"]);
  dropdown.addToPage(doc.getPage(1));
  const radio = form.createRadioGroup("Delivery");
  radio.addOptionToPage("Email", doc.getPage(1));
  radio.addOptionToPage("Post", doc.getPage(1));
  return doc;
}

export const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwAD/gFAWarX0QAAAAlwSFlzAAABbgAAAW4BDJZoaQAAAAdJREFUeNrsiVMHgQAQANuYAHsTAAAAAElFTkSuQmCC",
  ),
  (c) => c.charCodeAt(0),
);
