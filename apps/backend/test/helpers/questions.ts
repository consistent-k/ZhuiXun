import type { AskUserQuestionInput, AskUserQuestionOutput } from '@zhuixun/shared';

import type { StoredMessage } from '@/modules/conversations';

export const questionInput: AskUserQuestionInput = {
    questions: [
        {
            question: '选择方式？',
            header: '方式',
            options: [
                { label: '通知,邮件', description: '两个渠道', preview: '**预览**' },
                { label: '其他', description: '一个真实选项' }
            ],
            multiSelect: true
        },
        {
            question: '选择方式？',
            header: '偏好',
            options: [
                { label: 'A', description: '方式 A' },
                { label: 'B', description: '方式 B' }
            ]
        }
    ]
};
export const questionOutput: AskUserQuestionOutput = {
    answers: [
        {
            questionIndex: 0,
            question: '选择方式？',
            selectedOptions: ['通知,邮件', '其他'],
            customText: '工作日\n集中提醒'
        },
        { questionIndex: 1, question: '选择方式？', selectedOptions: [], customText: '自定义' }
    ]
};
export const pendingQuestionMessages: StoredMessage[] = [
    { id: 'user', role: 'user', content: '提问', parts: [{ type: 'text', text: '提问' }] },
    {
        id: 'assistant',
        role: 'assistant',
        content: '',
        parts: [
            { type: 'tool-askUserQuestion', toolCallId: 'question', state: 'input-available', input: questionInput }
        ]
    }
];
