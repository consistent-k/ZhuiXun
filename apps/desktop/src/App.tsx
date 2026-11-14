import { useEffect } from 'react';
import { RouterProvider } from 'react-router';

import UpdateNotifier from '@/components/UpdateNotifier';
import router from '@/routes';
import { useAppConfigStore, usePersonaStore } from '@/stores';
import BaseThemeProvider from '@/theme';

const App = () => {
    // 启动时拉取一次应用级偏好（默认对话模式等），供 chat 请求读取
    useEffect(() => {
        void useAppConfigStore.getState().hydrate();
        void usePersonaStore.getState().hydrate();
    }, []);

    return (
        <BaseThemeProvider>
            <UpdateNotifier />
            <RouterProvider router={router} />
        </BaseThemeProvider>
    );
};

export default App;
