/** askUserQuestion 跨 HTTP 的输入与答案契约。 */
export interface AskUserQuestionOption {
    label: string;
    description: string;
    preview?: string;
}

export interface AskUserQuestion {
    question: string;
    header: string;
    options: AskUserQuestionOption[];
    multiSelect?: boolean;
}

export interface AskUserQuestionInput {
    questions: AskUserQuestion[];
}

export interface AskUserQuestionAnswer {
    questionIndex: number;
    question: string;
    selectedOptions: string[];
    customText?: string;
}

export interface AskUserQuestionOutput {
    answers: AskUserQuestionAnswer[];
}
