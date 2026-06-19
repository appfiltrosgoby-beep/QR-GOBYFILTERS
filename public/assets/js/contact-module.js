/**
 * Módulo de información de contacto (UI)
 * Renderiza un panel de contacto en la vista `contactView`.
 */

(function () {
    'use strict';

    const DEFAULT_CONTACT_INFO = {
        heading: '📞 Contactanos',
        hint: 'Canales oficiales de INDUSTRIAS GOBY.',
        addressLabel: 'Dirección',
        addressValue: 'Dosquebradas, Risaralda, Colombia.',
        emailLabel: 'Email',
        emailValue: 'contacto@gobyfilters.com',
        phoneLabel: 'Teléfono',
        phoneValue: '+57 3108425071',
        whatsappLabel: 'WhatsApp',
        whatsappValue: '+57 314 8742393'
    };

    function createContactCard({ icon, title, badgeClass, value, href, smallNote }) {
        const card = document.createElement('div');
        card.className = 'stat-card contact-card';

        const header = document.createElement('div');
        header.className = 'contact-card-header';

        const iconEl = document.createElement('div');
        iconEl.className = 'stat-icon';
        iconEl.textContent = icon;

        const info = document.createElement('div');
        info.className = 'stat-info';

        const badge = document.createElement('span');
        badge.className = `type-badge ${badgeClass}`;
        badge.textContent = title;

        const valueEl = href ? document.createElement('a') : document.createElement('div');
        if (href) {
            valueEl.href = href;
            valueEl.target = href.startsWith('http') ? '_blank' : '';
            valueEl.rel = href.startsWith('http') ? 'noopener noreferrer' : '';
            valueEl.className = 'contact-link';
            valueEl.textContent = value;
        } else {
            valueEl.className = 'contact-value';
            valueEl.textContent = value;
        }

        info.appendChild(valueEl);

        if (smallNote) {
            const note = document.createElement('div');
            note.className = 'contact-note';
            note.textContent = smallNote;
            info.appendChild(note);
        }

        header.appendChild(iconEl);
        header.appendChild(badge);

        card.appendChild(header);
        card.appendChild(info);

        return card;
    }

    function render(targetOrId, overrides) {
        const info = { ...DEFAULT_CONTACT_INFO, ...(overrides || {}) };

        const target = typeof targetOrId === 'string'
            ? document.getElementById(targetOrId)
            : targetOrId;

        if (!target) {
            return;
        }

        target.innerHTML = '';

        const header = document.createElement('div');
        header.className = 'contact-header';

        const heading = document.createElement('h3');
        heading.textContent = info.heading;

        const hint = document.createElement('p');
        hint.className = 'contact-hint';
        hint.textContent = info.hint;

        header.appendChild(heading);
        header.appendChild(hint);

        const grid = document.createElement('div');
        grid.className = 'stats-grid contact-grid';

        grid.appendChild(createContactCard({
            icon: '📍',
            title: info.addressLabel,
            badgeClass: 'type-texto',
            value: info.addressValue
        }));

        grid.appendChild(createContactCard({
            icon: '✉️',
            title: info.emailLabel,
            badgeClass: 'type-email',
            value: info.emailValue,
            href: `mailto:${info.emailValue}`
        }));

        const cleanPhone = (info.phoneValue || '').replace(/\s+/g, '').replace(/[()]/g, '');
        grid.appendChild(createContactCard({
            icon: '☎️',
            title: info.phoneLabel,
            badgeClass: 'type-teléfono',
            value: info.phoneValue,
            href: cleanPhone ? `tel:${cleanPhone}` : ''
        }));

        const cleanWhatsapp = (info.whatsappValue || '').replace(/\s+/g, '').replace(/[()+-]/g, '');
        grid.appendChild(createContactCard({
            icon: '💬',
            title: info.whatsappLabel,
            badgeClass: 'type-whatsapp',
            value: info.whatsappValue,
            href: cleanWhatsapp ? `https://wa.me/${cleanWhatsapp}` : ''
        }));

        target.appendChild(header);
        target.appendChild(grid);
    }

    window.GOBY_CONTACT_MODULE = {
        DEFAULT_CONTACT_INFO,
        render
    };
})();
