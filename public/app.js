document.querySelectorAll("[data-select-on-focus]").forEach((input) => {
  input.addEventListener("focus", () => input.select(), { once: true });
});

const contactList = document.querySelector("[data-contact-list]");
const addContactButton = document.querySelector("[data-add-contact]");

if (contactList && addContactButton) {
  const contactRows = () => [...contactList.querySelectorAll("[data-contact-row]")];
  const updateContactButton = () => {
    addContactButton.hidden = !contactRows().some((row) => row.hidden);
  };

  addContactButton.addEventListener("click", () => {
    const row = contactRows().find((candidate) => candidate.hidden);
    if (!row) return;
    row.hidden = false;
    updateContactButton();
    row.querySelector("select")?.focus();
  });
  updateContactButton();
}

const imageInput = document.querySelector("[data-image-input]");
const imageSelection = document.querySelector("#image-selection");

if (imageInput && imageSelection) {
  const MAX_IMAGE_WIDTH = 1600;
  const MAX_IMAGE_HEIGHT = 1200;
  let imagePreparation = null;

  // ponytail: resize in the browser to keep the single-process app dependency-free; add server-side image processing if non-browser clients become a requirement.
  async function resizeImage(file) {
    if (!window.createImageBitmap) return file;
    const bitmap = await window.createImageBitmap(file);
    try {
      const scale = Math.min(1, MAX_IMAGE_WIDTH / bitmap.width, MAX_IMAGE_HEIGHT / bitmap.height);
      if (scale === 1) return file;

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const outputType = file.type === "image/png" ? "image/png" : file.type === "image/webp" ? "image/webp" : "image/jpeg";
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, outputType, 0.86));
      return blob ? new File([blob], file.name, { type: outputType, lastModified: file.lastModified }) : file;
    } finally {
      bitmap.close?.();
    }
  }

  async function prepareImages() {
    const selected = [...imageInput.files];
    if (!selected.length) {
      imageSelection.textContent = "";
      return;
    }
    imageSelection.textContent = "Preparing photos…";
    const processed = await Promise.all(selected.map((file) => resizeImage(file).catch(() => file)));
    const transfer = new DataTransfer();
    processed.forEach((file) => transfer.items.add(file));
    imageInput.files = transfer.files;
    imageSelection.textContent = `${processed.length} photo${processed.length === 1 ? "" : "s"} selected.`;
  }

  imageInput.addEventListener("change", () => {
    imagePreparation = prepareImages();
  });

  imageInput.form?.addEventListener("submit", async (event) => {
    if (!imagePreparation) return;
    const form = event.currentTarget;
    event.preventDefault();
    const preparation = imagePreparation;
    imagePreparation = null;
    await preparation;
    form.requestSubmit();
  });
}
