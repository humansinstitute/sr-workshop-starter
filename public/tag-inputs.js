export function initTagInputs() {
  document.querySelectorAll(".tag-input-wrapper").forEach((wrapper) => {
    const input = wrapper.querySelector("input[type='text']");
    const hiddenInput = wrapper.querySelector("input[type='hidden']");
    if (!input || !hiddenInput) return;

    function syncTags() {
      const chips = wrapper.querySelectorAll(".tag-chip");
      const tags = Array.from(chips)
        .map((c) => c.dataset.tag)
        .filter(Boolean);
      hiddenInput.value = tags.join(",");
    }

    function addTag(text) {
      const tag = text.trim().toLowerCase().replace(/,/g, "");
      if (!tag) return;
      const existing = wrapper.querySelectorAll(".tag-chip");
      for (const chip of existing) {
        if (chip.dataset.tag === tag) return;
      }
      const chip = document.createElement("span");
      chip.className = "tag-chip";
      chip.dataset.tag = tag;
      chip.innerHTML = `${tag}<span class="remove-tag">&times;</span>`;
      chip.querySelector(".remove-tag").addEventListener("click", () => {
        chip.remove();
        syncTags();
      });
      wrapper.insertBefore(chip, input);
      syncTags();
    }

    function removeLastTag() {
      const chips = wrapper.querySelectorAll(".tag-chip");
      if (chips.length > 0) {
        chips[chips.length - 1].remove();
        syncTags();
      }
    }

    input.addEventListener("keydown", (e) => {
      if (e.key === "," || e.key === "Enter") {
        e.preventDefault();
        addTag(input.value);
        input.value = "";
      } else if (e.key === "Backspace" && input.value === "") {
        removeLastTag();
      }
    });

    input.addEventListener("blur", () => {
      if (input.value.trim()) {
        addTag(input.value);
        input.value = "";
      }
    });

    wrapper.addEventListener("click", () => input.focus());

    wrapper.querySelectorAll(".tag-chip .remove-tag").forEach((btn) => {
      btn.addEventListener("click", () => {
        btn.parentElement.remove();
        syncTags();
      });
    });
  });
}
