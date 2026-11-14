import { createI18n } from '@zhuixun/i18n';

import { en } from './locales/en';
import { zh } from './locales/zh';

const i18n = createI18n();
i18n.registerLocale('zh', '中文', zh);
i18n.registerLocale('en', 'English', en);

export const { t, getLocale, setLocale, registerLocale, getSupportedLocales } = i18n;
