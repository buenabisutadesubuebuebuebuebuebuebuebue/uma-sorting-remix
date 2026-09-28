// ==UserScript==
// @name         Uma Sorting Remix
// @namespace    https://snep.pw/
// @version      0.6.7
// @description  Help you quickly edit your Uma sorter without going through the whole sorting process again
// @author       Meewko
// @match        https://snep.pw/uma/sorter/result/*
// @run-at       document-idle
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/Sortable.min.js
// ==/UserScript==

(() => {
    'use strict';

    const ID = 'uma-sorting-remix';
    const SORTER_URL = '/uma/sorter/sorting?group=horsegirls';
    const SUBMIT_URL = '/_actions/uma.sorter.submit/';
    const RESULT_PATH = '/uma/sorter/result/';
    const MAX_HISTORY = 40;

    if (window.top !== window.self || document.getElementById(`${ID}-launch`)) return;
    installStyles();

    const sections = [...document.querySelectorAll('main .results')];
    let source;
    try {
        source = readResultPage(sections);
    } catch (error) {
        console.error('[Uma Sorting Remix] Result parsing failed:', error);
        installUnavailableNotice(error.message);
        return;
    }

    const sourceOrder = source.map(({ slug }) => slug);
    const characters = new Map(source.map((character) => [character.slug, character]));
    const initialSlots = sections.flatMap((section) => [...section.children]);
    const smallTemplate = initialSlots.at(-1)?.cloneNode(true);
    let order = [...sourceOrder];
    let slots = [...initialSlots];
    let history = [];
    let sortables = [];
    let toolbar = null;
    let missingSection = null;
    let missingList = null;
    let active = false;
    let saving = false;
    let dragStartOrder = null;
    let selectedSlug = null;
    let discardArmed = false;
    let discardTimer = null;

    installLaunchButton();

    function actionArea() {
        return document.querySelector('main .actions .action-row') || document.querySelector('main .actions');
    }

    function installLaunchButton() {
        const button = create('button', {
            id: `${ID}-launch`, className: 'button srr-launch', type: 'button', textContent: 'Edit This Sorting'
        });
        button.addEventListener('click', startEditing);
        actionArea()?.append(button);
    }

    function installUnavailableNotice(message) {
        const notice = create('span', {
            className: 'srr-unavailable',
            textContent: 'Sorting editor unavailable: this page no longer matches the expected result format.'
        });
        notice.title = message;
        actionArea()?.append(notice);
    }

    async function startEditing() {
        if (active) return;
        active = true;
        document.body.classList.add('srr-editing');
        document.getElementById(`${ID}-launch`).hidden = true;
        toolbar = buildToolbar();
        document.querySelector('main .header')?.insertAdjacentElement('afterend', toolbar);
        slots.forEach(decorateSlot);
        sections.forEach((section) => section.setAttribute('role', 'list'));
        applyOrder(order);
        const dragReady = enableSorting();
        updateControls();
        announce(dragReady
            ? 'Editing enabled. Drag any character to a new position.'
            : 'Drag support did not load. Reinstall the userscript or use the move buttons.', !dragReady);

        try {
            const catalog = await loadCatalog();
            if (!active || !toolbar) return;
            catalog.forEach((character) => characters.set(character.slug, character));
            buildMissingSection();
            renderMissing();
            const catalogDragReady = enableSorting();
            announce(catalogDragReady
                ? `${missingCharacterCount()} missing characters are ready to drag into this sorting.`
                : 'The character catalog loaded, but drag support is unavailable. Reload the page and try again.', !catalogDragReady);
        } catch (error) {
            console.error('[Uma Sorting Remix] Catalog failed:', error);
            if (!active || !toolbar) return;
            announce('Reordering works, but the character catalog could not be loaded.', true);
        }
    }

    function buildToolbar() {
        const node = create('section', { className: 'srr-toolbar', ariaLabel: 'Sorting edit controls' });
        node.innerHTML = `
            <div class="srr-toolbar-copy">
                <strong>Editing this sorting</strong>
            </div>
            <div class="srr-toolbar-actions">
                <button type="button" data-action="earlier" disabled>Move earlier</button>
                <button type="button" data-action="later" disabled>Move later</button>
                <button type="button" data-action="remove" disabled>Remove</button>
                <button type="button" data-action="undo" disabled>Undo</button>
                <button type="button" data-action="reset" disabled>Reset</button>
                <button type="button" data-action="exit">Exit</button>
                <button type="button" class="srr-primary" data-action="save">Create new result</button>
            </div>
            <span class="srr-live" role="status" aria-live="polite" data-live></span>`;
        node.addEventListener('click', (event) => {
            const action = event.target.closest('[data-action]')?.dataset.action;
            if (action === 'earlier') moveSelected(-1);
            if (action === 'later') moveSelected(1);
            if (action === 'remove') removeCharacter(selectedSlug);
            if (action === 'undo') undo();
            if (action === 'reset') reset();
            if (action === 'exit') stopEditing();
            if (action === 'save') submitSorting();
        });
        return node;
    }

    function enableSorting() {
        disableSorting();
        const SortableClass = typeof Sortable === 'function' ? Sortable : window.Sortable;
        if (typeof SortableClass !== 'function') return false;
        const containers = missingList ? [...sections, missingList] : sections;
        sortables = containers.map((section) => new SortableClass(section, {
            group: ID,
            animation: 180,
            draggable: '[data-srr-slug]',
            delay: 180,
            delayOnTouchOnly: true,
            touchStartThreshold: 5,
            ghostClass: 'srr-ghost',
            chosenClass: 'srr-chosen',
            dragClass: 'srr-dragging',
            forceFallback: true,
            fallbackOnBody: true,
            fallbackTolerance: 4,
            onStart: () => { dragStartOrder = [...order]; },
            onEnd: ({ item, to }) => {
                const movedSlug = item.dataset.srrSlug;
                const next = readRankedOrder();
                const isRanked = sections.includes(to);
                const startOrder = dragStartOrder ? [...dragStartOrder] : null;
                dragStartOrder = null;
                setTimeout(() => finishDrag(startOrder, next, movedSlug, isRanked), 0);
            }
        }));
        return true;
    }

    function finishDrag(startOrder, next, movedSlug, isRanked) {
        cleanupDragArtifacts();
        if (!active || !startOrder) return;
        const wasRanked = startOrder.includes(movedSlug);
        const expectedLength = startOrder.length + (isRanked && !wasRanked ? 1 : !isRanked && wasRanked ? -1 : 0);
        if (next.length !== expectedLength) {
            restoreSlotLayout();
            applyOrder(startOrder);
            announce('That move could not be applied cleanly. Please try it again.', true);
            return;
        }
        if (arraysEqual(next, startOrder)) {
            restoreSlotLayout();
            applyOrder(order);
            return;
        }
        remember(startOrder);
        order = next;
        selectedSlug = order.includes(movedSlug) ? movedSlug : null;
        restoreSlotLayout();
        applyOrder(order);
        const position = order.indexOf(movedSlug);
        announce(position >= 0
            ? `${characters.get(movedSlug)?.name || 'Character'} moved to position ${position + 1}.`
            : `${characters.get(movedSlug)?.name || 'Character'} moved to Missing characters.`);
    }

    function cleanupDragArtifacts() {
        document.querySelectorAll('[data-srr-slug].sortable-fallback').forEach((card) => card.remove());
        document.querySelectorAll('[data-srr-slug].srr-dragging').forEach((card) => {
            if (!slots.includes(card) && !missingList?.contains(card)) card.remove();
        });
        document.querySelectorAll('[data-srr-slug].srr-dragging, [data-srr-slug].srr-ghost, [data-srr-slug].srr-chosen')
            .forEach((card) => card.classList.remove('srr-dragging', 'srr-ghost', 'srr-chosen'));
    }

    function readRankedOrder() {
        const seen = new Set();
        const next = [];
        sections.forEach((section) => {
            [...section.children].forEach((card) => {
                if (card.classList.contains('sortable-fallback')) return;
                const slug = card.dataset.srrSlug;
                if (!slug || seen.has(slug)) return;
                seen.add(slug);
                next.push(slug);
            });
        });
        return next;
    }

    function disableSorting() {
        sortables.forEach((sortable) => sortable.destroy());
        sortables = [];
    }

    function decorateSlot(slot) {
        slot.classList.add('srr-sortable-character');
        slot.tabIndex = 0;
        slot.setAttribute('role', 'listitem');
        slot.addEventListener('keydown', handleSlotKeydown);
        slot.addEventListener('focus', handleSlotFocus);
        slot.addEventListener('click', handleSlotClick);
        if (slot.querySelector('.srr-drag-handle')) return;
        const handle = create('span', { className: 'srr-drag-handle', ariaHidden: 'true' });
        handle.innerHTML = '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M5 3h2v2H5V3Zm6 0h2v2h-2V3ZM5 8h2v2H5V8Zm6 0h2v2h-2V8ZM5 13h2v2H5v-2Zm6 0h2v2h-2v-2Z"/></svg>';
        slot.append(handle);
    }

    function handleSlotFocus(event) {
        selectedSlug = event.currentTarget.dataset.srrSlug;
        slots.forEach((slot) => slot.classList.toggle('srr-selected', slot.dataset.srrSlug === selectedSlug));
        updateControls();
    }

    function handleSlotClick(event) {
        if (!event.target.closest('button')) event.currentTarget.focus();
    }

    function handleSlotKeydown(event) {
        if (saving) return;
        if (!event.altKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        const slug = event.currentTarget.dataset.srrSlug;
        const from = order.indexOf(slug);
        const to = from + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1);
        if (from < 0 || to < 0 || to >= order.length) return;
        remember();
        order.splice(from, 1);
        order.splice(to, 0, slug);
        applyOrder(order);
        slots[to]?.focus();
        announce(`${characters.get(slug)?.name || 'Character'} moved to position ${to + 1}.`);
    }

    function applyOrder(next) {
        ensureSlotCount(next.length);
        restoreSlotLayout();
        slots.forEach((slot, index) => renderCharacter(slot, characters.get(next[index]), index));
        order = [...next];
        slots.forEach((slot) => slot.classList.toggle('srr-selected', slot.dataset.srrSlug === selectedSlug));
        renderMissing();
        updateControls();
    }

    function renderCharacter(slot, character, index) {
        if (!character) return;
        slot.dataset.srrSlug = character.slug;
        slot.style.setProperty('--primary', character.primary || '#777');
        slot.style.setProperty('--secondary', character.secondary || '#aaa');
        slot.setAttribute('aria-label', `Position ${index + 1}: ${character.name}. Drag to reorder, or use Alt and arrow keys.`);
        const background = [...slot.querySelectorAll('.image')].find((node) => !node.querySelector('img'));
        if (background) background.style.backgroundImage = `url("${mainImage(character.slug)}")`;
        const thumbnail = slot.querySelector('img[src*="/uma/characters/"]');
        if (thumbnail) {
            thumbnail.src = thumbImage(character.slug);
            thumbnail.alt = character.name;
        }
        const name = slot.querySelector('.name-lg, .caption');
        if (name) name.textContent = character.name;
        const number = slot.querySelector('.name-sm');
        if (number) number.textContent = `#${index + 1}`;
    }

    function restoreSlotLayout() {
        const first = Math.min(3, slots.length);
        const second = Math.min(15, Math.max(0, slots.length - first));
        sections[0]?.replaceChildren(...slots.slice(0, first));
        sections[1]?.replaceChildren(...slots.slice(first, first + second));
        sections[2]?.replaceChildren(...slots.slice(first + second));
    }

    function ensureSlotCount(count) {
        while (slots.length < count) {
            if (!smallTemplate || !sections[2]) throw new Error('Could not create another result position.');
            const slot = smallTemplate.cloneNode(true);
            decorateSlot(slot);
            slots.push(slot);
        }
        while (slots.length > count) slots.pop().remove();
    }

    function removeCharacter(slug) {
        if (saving || !slug) return;
        const index = order.indexOf(slug);
        if (index < 0) return;
        remember();
        order.splice(index, 1);
        selectedSlug = order[Math.min(index, order.length - 1)] || null;
        applyOrder(order);
        slots[Math.min(index, slots.length - 1)]?.focus();
        announce(`${characters.get(slug)?.name || 'Character'} removed from this sorting.`);
    }

    function moveSelected(delta) {
        if (saving || !selectedSlug) return;
        const from = order.indexOf(selectedSlug);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= order.length) return;
        remember();
        order.splice(from, 1);
        order.splice(to, 0, selectedSlug);
        applyOrder(order);
        slots[to]?.focus();
        announce(`${characters.get(selectedSlug)?.name || 'Character'} moved to position ${to + 1}.`);
    }

    function remember(snapshot = order) {
        disarmDiscard();
        history.push([...snapshot]);
        if (history.length > MAX_HISTORY) history.shift();
        updateControls();
    }

    function undo() {
        const previous = history.pop();
        if (!previous) return;
        applyOrder(previous);
        announce('Last change undone.');
    }

    function reset() {
        if (arraysEqual(order, sourceOrder)) return;
        remember();
        applyOrder(sourceOrder);
        announce('Original sorting restored.');
    }

    function stopEditing() {
        if (saving) return;
        if (!arraysEqual(order, sourceOrder) && !discardArmed) {
            discardArmed = true;
            updateControls();
            announce('Press “Confirm discard” to exit and restore the original sorting.', true);
            clearTimeout(discardTimer);
            discardTimer = setTimeout(disarmDiscard, 5000);
            return;
        }
        disableSorting();
        history = [];
        applyOrder(sourceOrder);
        slots.forEach((slot) => {
            slot.classList.remove('srr-sortable-character');
            slot.classList.remove('srr-selected');
            slot.removeAttribute('tabindex');
            slot.removeAttribute('role');
            slot.removeAttribute('aria-label');
            slot.removeAttribute('data-srr-slug');
            slot.removeEventListener('keydown', handleSlotKeydown);
            slot.removeEventListener('focus', handleSlotFocus);
            slot.removeEventListener('click', handleSlotClick);
            slot.querySelector('.srr-drag-handle')?.remove();
        });
        sections.forEach((section) => section.removeAttribute('role'));
        missingSection?.remove();
        missingSection = null;
        missingList = null;
        toolbar?.remove();
        toolbar = null;
        document.body.classList.remove('srr-editing');
        document.getElementById(`${ID}-launch`).hidden = false;
        active = false;
        selectedSlug = null;
        disarmDiscard();
    }

    function disarmDiscard() {
        discardArmed = false;
        clearTimeout(discardTimer);
        if (toolbar) updateControls();
    }

    function updateControls() {
        if (!toolbar) return;
        const changed = !arraysEqual(order, sourceOrder);
        const selectedIndex = order.indexOf(selectedSlug);
        toolbar.querySelector('[data-action="earlier"]').disabled = saving || selectedIndex <= 0;
        toolbar.querySelector('[data-action="later"]').disabled = saving || selectedIndex < 0 || selectedIndex >= order.length - 1;
        toolbar.querySelector('[data-action="remove"]').disabled = saving || selectedIndex < 0;
        toolbar.querySelector('[data-action="undo"]').disabled = !history.length || saving;
        toolbar.querySelector('[data-action="reset"]').disabled = !changed || saving;
        toolbar.querySelector('[data-action="exit"]').disabled = saving;
        toolbar.querySelector('[data-action="exit"]').textContent = changed ? (discardArmed ? 'Confirm discard' : 'Discard edits') : 'Exit';
        toolbar.querySelector('[data-action="save"]').disabled = !order.length || saving;
        toolbar.querySelector('[data-action="save"]').textContent = saving ? 'Creating result…' : 'Create new result';
    }

    function announce(message, error = false) {
        const live = toolbar?.querySelector('[data-live]');
        if (!live) return;
        live.textContent = message;
        live.classList.toggle('srr-error', error);
    }

    function buildMissingSection() {
        if (missingSection) return;
        missingSection = create('section', { className: 'srr-missing', ariaLabel: 'Missing characters' });
        missingSection.innerHTML = `
            <div class="srr-missing-heading">
                <h2>Missing characters</h2>
            </div>
            <div class="srr-missing-list" role="list"></div>`;
        missingList = missingSection.querySelector('.srr-missing-list');
        sections.at(-1)?.insertAdjacentElement('afterend', missingSection);
    }

    function renderMissing() {
        if (!missingList) return;
        const used = new Set(order);
        const available = [...characters.values()]
            .filter(({ slug }) => !used.has(slug))
            .sort((a, b) => a.name.localeCompare(b.name));
        missingList.replaceChildren(...available.map((character) => {
            const card = smallTemplate.cloneNode(true);
            card.classList.add('srr-missing-card');
            card.dataset.srrSlug = character.slug;
            card.tabIndex = 0;
            card.setAttribute('role', 'listitem');
            card.setAttribute('aria-label', `${character.name}. Drag into the sorting to add, or press Enter to add at the end.`);
            card.addEventListener('keydown', handleMissingKeydown);
            card.style.setProperty('--primary', character.primary || '#777');
            card.style.setProperty('--secondary', character.secondary || '#aaa');
            const rank = card.querySelector('.name-sm');
            if (rank) {
                rank.textContent = '\u00a0';
                rank.setAttribute('aria-hidden', 'true');
            }
            const thumbnail = card.querySelector('img[src*="/uma/characters/"]');
            if (thumbnail) {
                thumbnail.src = thumbImage(character.slug);
                thumbnail.alt = character.name;
            }
            const name = card.querySelector('.caption');
            if (name) name.textContent = character.name;
            return card;
        }));
        if (!available.length) {
            missingList.append(create('p', { className: 'srr-missing-empty', textContent: 'Every character is currently in this sorting.' }));
        }
    }

    function missingCharacterCount() {
        const used = new Set(order);
        return [...characters.keys()].filter((slug) => !used.has(slug)).length;
    }

    function handleMissingKeydown(event) {
        if (saving || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        const slug = event.currentTarget.dataset.srrSlug;
        if (!characters.has(slug) || order.includes(slug)) return;
        remember();
        order.push(slug);
        selectedSlug = slug;
        applyOrder(order);
        slots.at(-1)?.focus();
        announce(`${characters.get(slug).name} added at position ${order.length}.`);
    }

    async function submitSorting() {
        if (saving || !order.length) return;
        const problem = validateOrder();
        if (problem) return announce(problem, true);
        saving = true;
        disableSorting();
        updateControls();
        announce('Creating your new result…');
        try {
            const response = await fetch(SUBMIT_URL, {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({ list: readListName(), result: order, type: 'uma_character', version: 'default', name: readResultName() })
            });
            const text = await response.text();
            if (!response.ok) throw new Error(readServerError(text, response.status));
            const resultId = parseActionResponse(text);
            if (typeof resultId !== 'string' || !resultId) throw new Error('Snep returned an unexpected response. Your edits are still here.');
            window.location.assign(`${RESULT_PATH}${encodeURIComponent(resultId)}`);
        } catch (error) {
            console.error('[Uma Sorting Remix] Submit failed:', error);
            saving = false;
            enableSorting();
            updateControls();
            announce(error.message || 'Could not create the result. Check your connection and try again.', true);
        }
    }

    function validateOrder() {
        if (new Set(order).size !== order.length) return 'This sorting contains a duplicate character. Reload and try again.';
        const invalid = order.find((slug) => !characters.has(slug) || !/^[a-z0-9-]+$/.test(slug));
        return invalid ? `The character “${invalid}” could not be verified. Nothing was submitted.` : '';
    }

    function readResultPage(groups) {
        const cards = groups.flatMap((group) => [...group.children]);
        if (!cards.length) throw new Error('No result cards were found.');
        const parsed = cards.map((card) => {
            const thumbnail = card.querySelector('img[src*="/uma/characters/"]');
            const background = [...card.querySelectorAll('[style*="/uma/characters/"]')][0];
            const url = thumbnail?.src || background?.style.backgroundImage || '';
            const slug = url.match(/\/uma\/characters\/([^/"')]+)\//)?.[1];
            if (!slug) return null;
            return {
                slug,
                name: card.querySelector('.name-lg, .caption')?.textContent.trim() || humanizeSlug(slug),
                primary: card.style.getPropertyValue('--primary').trim(),
                secondary: card.style.getPropertyValue('--secondary').trim()
            };
        }).filter(Boolean);
        if (parsed.length !== cards.length) throw new Error(`Parsed ${parsed.length} of ${cards.length} result cards.`);
        if (new Set(parsed.map(({ slug }) => slug)).size !== parsed.length) throw new Error('Duplicate character identifiers were found.');
        return parsed;
    }

    async function loadCatalog() {
        const response = await fetch(SORTER_URL, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`Catalog request failed (${response.status})`);
        const page = new DOMParser().parseFromString(await response.text(), 'text/html');
        const island = [...page.querySelectorAll('astro-island')].find((node) => node.getAttribute('component-url')?.includes('UmaCharacterSorter'));
        if (!island) throw new Error('Sorter data was not found.');
        const props = decodeAstroValue(JSON.parse(island.getAttribute('props')));
        return props.characters.map((character) => ({
            slug: character.siteId,
            name: character.nameEN || humanizeSlug(character.siteId),
            primary: `#${character.colors?.main || '777777'}`,
            secondary: `#${character.colors?.sub || 'aaaaaa'}`
        })).filter(({ slug }) => slug);
    }

    function decodeAstroValue(tuple) {
        if (!Array.isArray(tuple)) {
            if (typeof tuple !== 'object' || tuple === null) return tuple;
            return Object.fromEntries(Object.entries(tuple).map(([key, value]) => [key, decodeAstroValue(value)]));
        }
        const [type, value] = tuple;
        const array = (items) => items.map(decodeAstroValue);
        const object = (item) => typeof item !== 'object' || item === null ? item : Object.fromEntries(Object.entries(item).map(([key, child]) => [key, decodeAstroValue(child)]));
        const decoders = { 0: object, 1: array, 2: (x) => new RegExp(x), 3: (x) => new Date(x), 4: (x) => new Map(array(x)), 5: (x) => new Set(array(x)), 6: (x) => BigInt(x), 7: (x) => new URL(x), 8: (x) => new Uint8Array(x), 9: (x) => new Uint16Array(x), 10: (x) => new Uint32Array(x), 11: (x) => x * Infinity };
        return decoders[type]?.(value);
    }

    function parseActionResponse(text) {
        const values = JSON.parse(text);
        if (!Array.isArray(values)) return values;
        const hydrated = new Array(values.length);
        const special = { '-1': undefined, '-2': Symbol('hole'), '-3': NaN, '-4': Infinity, '-5': -Infinity, '-6': -0 };
        const decode = (index, top = false) => {
            if (typeof index === 'number' && index < 0) {
                if (top) throw new Error('Invalid action response.');
                return special[index];
            }
            if (typeof index !== 'number') return index;
            if (index in hydrated) return hydrated[index];
            const value = values[index];
            if (!value || typeof value !== 'object') return (hydrated[index] = value);
            const output = Array.isArray(value) ? [] : {};
            hydrated[index] = output;
            if (Array.isArray(value)) value.forEach((item) => output.push(decode(item)));
            else Object.entries(value).forEach(([key, item]) => { output[key] = decode(item); });
            return output;
        };
        return decode(0, true);
    }

    function readServerError(text, status) {
        try {
            const parsed = JSON.parse(text);
            return parsed.message || parsed.error?.message || `Snep rejected the result (${status}).`;
        } catch { return `Snep rejected the result (${status}).`; }
    }

    function readListName() {
        const text = [...document.querySelectorAll('main .header p')].map((node) => node.textContent.trim()).find((value) => value.startsWith('From:'));
        return text?.replace(/^From:\s*/, '').trim() || 'All Horse Girls';
    }
    function readResultName() { return (document.querySelector('main .header h1')?.textContent || '').replace(/[’']s Sorting Results$/i, '').trim(); }
    function mainImage(slug) { return `https://static.snep.pw/uma/characters/${encodeURIComponent(slug)}/main_crop.png`; }
    function thumbImage(slug) { return `https://static.snep.pw/uma/characters/${encodeURIComponent(slug)}/thumb_square.png`; }
    function humanizeSlug(slug) { return slug.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' '); }
    function arraysEqual(a, b) { return a.length === b.length && a.every((value, index) => value === b[index]); }
    function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
    function escapeAttribute(value) { return escapeHtml(value || ''); }
    function create(tag, properties = {}) {
        const node = document.createElement(tag);
        Object.entries(properties).forEach(([key, value]) => key in node ? node[key] = value : node.setAttribute(key, value));
        return node;
    }

    function installStyles() {
        const style = create('style', { id: `${ID}-styles` });
        style.textContent = `
            .srr-launch{margin:0}.srr-unavailable{display:block;max-width:34ch;color:#ef9aac;font-size:.85rem;line-height:1.35}
            .srr-toolbar{position:sticky;top:0;z-index:40;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.65rem 1rem;margin:0 10px 1.25rem;padding:.7rem .85rem;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:10px;background:var(--background-color,#21191f);box-shadow:0 8px 22px rgba(0,0,0,.22)}
            .srr-toolbar-copy{min-width:13rem}.srr-toolbar-copy strong{font-size:.95rem}.srr-live{color:color-mix(in srgb,currentColor 68%,transparent);font-size:.78rem}.srr-toolbar-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:.4rem}
            .srr-toolbar button{min-height:40px;border:0;border-radius:8px;padding:.5rem .75rem;background:var(--background-color-secondary,#4c293b);color:inherit;font:inherit;font-weight:700;cursor:pointer}.srr-toolbar button:hover:not(:disabled){filter:brightness(1.15)}.srr-toolbar button:disabled{cursor:not-allowed;opacity:.45}.srr-toolbar .srr-primary{background:#9f3454;color:#fff}.srr-live{flex-basis:100%;min-height:1.1em;text-align:right}.srr-live.srr-error{color:#ff9aaa}
            body.srr-editing .srr-sortable-character{position:relative;cursor:grab;user-select:none;-webkit-user-select:none;outline:2px solid transparent;outline-offset:5px;transition:outline-color 150ms ease,filter 150ms ease}body.srr-editing .srr-sortable-character *{user-select:none;-webkit-user-select:none}body.srr-editing .srr-sortable-character img{-webkit-user-drag:none}body.srr-editing .srr-sortable-character:hover{outline-color:color-mix(in srgb,currentColor 45%,transparent)}body.srr-editing .srr-sortable-character:focus-visible,body.srr-editing .srr-sortable-character.srr-selected{outline:3px solid #77d7ec}body.srr-editing .srr-sortable-character:active{cursor:grabbing}
            .srr-drag-handle{position:absolute;top:7px;right:7px;z-index:5;display:grid;place-items:center;width:40px;height:40px;border:0;border-radius:8px;background:rgba(35,24,31,.9);color:#fff;cursor:grab;touch-action:none;opacity:0;transition:opacity 140ms ease}.srr-drag-handle svg{width:22px;height:22px;fill:currentColor}.srr-drag-handle:active{cursor:grabbing}.srr-sortable-character:hover .srr-drag-handle,.srr-sortable-character:focus-within .srr-drag-handle{opacity:1}.srr-ghost{opacity:.22!important}.srr-chosen{filter:brightness(1.08)}.srr-dragging{cursor:grabbing!important;box-shadow:0 16px 38px rgba(0,0,0,.34)}
            @media(pointer:fine){.srr-drag-handle{display:none}}
            .srr-missing{margin:3rem 10px 1rem;padding-top:1.2rem;border-top:1px solid color-mix(in srgb,currentColor 30%,transparent)}.srr-missing-heading{margin-bottom:.9rem}.srr-missing-heading h2{margin:0;font-size:1.2rem}.srr-missing-list{display:flex;flex-wrap:wrap;justify-content:flex-start;gap:20px;min-height:150px}.srr-missing-card{position:relative;cursor:grab;user-select:none;-webkit-user-select:none;outline:2px solid transparent;outline-offset:5px}.srr-missing-card *{user-select:none;-webkit-user-select:none}.srr-missing-card img{-webkit-user-drag:none}.srr-missing-card:hover{outline-color:color-mix(in srgb,currentColor 45%,transparent)}.srr-missing-card:active{cursor:grabbing}.srr-missing-empty{align-self:center;margin:0;color:color-mix(in srgb,currentColor 68%,transparent)}
            .srr-toolbar button:focus-visible,.srr-drag-handle:focus-visible,.srr-missing-card:focus-visible{outline:3px solid #77d7ec;outline-offset:2px}
            @media(max-width:760px){.srr-toolbar{position:static;align-items:flex-start;flex-direction:column}.srr-toolbar-actions{justify-content:flex-start}.srr-toolbar button{min-height:44px}.srr-live{text-align:left}.srr-drag-handle{width:44px;height:44px;opacity:1}.srr-missing{margin-top:2rem;padding-top:1rem}.srr-missing-list{justify-content:space-around}}
            @media(prefers-reduced-motion:reduce){.srr-sortable-character,.srr-drag-handle{transition:none}}
        `;
        document.head.append(style);
    }
})();
