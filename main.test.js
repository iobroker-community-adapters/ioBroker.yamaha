'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

describe('admin jsonConfig migration', () => {
    const rootDir = __dirname;
    const adminDir = path.join(rootDir, 'admin');
    const ioPackage = JSON.parse(fs.readFileSync(path.join(rootDir, 'io-package.json'), 'utf8'));
    const jsonConfig = JSON.parse(fs.readFileSync(path.join(adminDir, 'jsonConfig.json'), 'utf8'));
    const translationKeys = [
        'IP Address',
        'Ping interval',
        'Poll Interval',
        'Realtime Options',
        'Use Realtime',
        'refreshOnRealtime',
    ];
    const translationLanguages = ['de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt', 'ru', 'zh-cn'];

    it('uses jsonConfig as admin UI', () => {
        expect(ioPackage.common.adminUI).to.deep.equal({ config: 'json' });
    });

    it('defines the migrated fields in admin/jsonConfig.json', () => {
        expect(jsonConfig).to.include({ type: 'panel', i18n: true });
        expect(jsonConfig.items).to.include.all.keys('ip', 'interval', 'useRealtime', 'refreshOnRealtime', 'realtimePing');
        expect(jsonConfig.items._realtimeHeader).to.include({ type: 'header', text: 'Realtime Options' });
    });

    it('uses the short-form translation files for all admin labels', () => {
        for (const language of translationLanguages) {
            const fileName = path.join(adminDir, 'i18n', `${language}.json`);
            expect(fs.existsSync(fileName), `${language}.json should exist`).to.be.true;

            const translations = JSON.parse(fs.readFileSync(fileName, 'utf8'));
            expect(translations).to.include.all.keys(translationKeys);
        }
    });

    it('removes the legacy materialize admin page', () => {
        expect(fs.existsSync(path.join(adminDir, 'index_m.html'))).to.be.false;
    });
});
