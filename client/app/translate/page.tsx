'use client';

import { useState, useRef } from 'react';
import { FileText, Globe } from 'react-feather';

// Must stay in sync with SUPPORTED_TARGET_LANGS in /api/translate-pdf.
const TARGET_LANGUAGES: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'ro', label: 'Română' },
  { code: 'es', label: 'Español' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'pl', label: 'Polski' },
  { code: 'hu', label: 'Magyar' },
  { code: 'cs', label: 'Čeština' },
  { code: 'sk', label: 'Slovenčina' },
  { code: 'bg', label: 'Български' },
  { code: 'el', label: 'Ελληνικά' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'ru', label: 'Русский' },
  { code: 'uk', label: 'Українська' },
  { code: 'sv', label: 'Svenska' },
  { code: 'no', label: 'Norsk' },
  { code: 'da', label: 'Dansk' },
  { code: 'fi', label: 'Suomi' },
  { code: 'ar', label: 'العربية' },
  { code: 'he', label: 'עברית' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'th', label: 'ไทย' },
  { code: 'zh-CN', label: '中文 (简体)' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
];


import { getErrorMessage } from '@/lib/errors';
export default function TranslatePDF() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isTranslating, setIsTranslating] = useState(false);
  const [translatedFile, setTranslatedFile] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0);
  const [targetLang, setTargetLang] = useState('en');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const targetLabel = TARGET_LANGUAGES.find((l) => l.code === targetLang)?.label || 'English';

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      if (file.type === 'application/pdf') {
        setSelectedFile(file);
        setError('');
        setTranslatedFile(null);
        setProgress(0);
      } else {
        setError('Only PDF files are allowed');
        setSelectedFile(null);
      }
    }
  };

  const handleTranslate = async () => {
    if (!selectedFile) return;

    setIsTranslating(true);
    setError('');
    setProgress(10);

    try {
      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('targetLang', targetLang);

      setProgress(30);

      const response = await fetch('/api/translate-pdf', {
        method: 'POST',
        body: formData,
      });

      setProgress(70);

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Translation failed');
      }

      // Get the translated PDF as blob
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);

      setTranslatedFile(url);
      setProgress(100);
    } catch (err) {
      setError(getErrorMessage(err) || 'Translation failed. Please try again.');
      console.error('Translation error:', err);
      setProgress(0);
    } finally {
      setIsTranslating(false);
    }
  };

  const removeFile = () => {
    setSelectedFile(null);
    setTranslatedFile(null);
    setError('');
    setProgress(0);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      if (file.type === 'application/pdf') {
        setSelectedFile(file);
        setError('');
        setTranslatedFile(null);
        setProgress(0);
      } else {
        setError('Only PDF files are allowed');
      }
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 to-gray-100 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-10">
          <h1 className="text-3xl font-extrabold text-gray-900 sm:text-4xl">
            PDF Translator
          </h1>
          <p className="mt-3 text-lg text-gray-600">
            Translate any PDF document into the language of your choice while preserving formulas and diagrams
          </p>
        </div>

        <div className="bg-white rounded-xl shadow-lg overflow-hidden p-8 mb-8">
          <div className="space-y-6">
            <div>
              <h2 className="text-xl text-black font-semibold mb-4">Upload PDF Document</h2>
              <p className="text-gray-600 mb-4">
                Upload a PDF in any language and choose the language to translate it into
              </p>

              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileSelect}
                accept=".pdf,application/pdf"
                className="hidden"
              />

              <div
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className="w-full flex justify-center items-center px-6 py-12 border-2 border-dashed border-gray-300 rounded-lg text-gray-500 hover:text-gray-700 hover:border-gray-400 transition-colors cursor-pointer"
              >
                <div className="text-center">
                  <svg className="mx-auto h-12 w-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path>
                  </svg>
                  <span className="mt-2 block text-sm font-medium">
                    {selectedFile
                      ? selectedFile.name
                      : 'Drag and drop or click to select PDF'}
                  </span>
                  {selectedFile && (
                    <span className="mt-1 block text-xs text-gray-400">
                      {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                    </span>
                  )}
                </div>
              </div>
            </div>

            {selectedFile && !translatedFile && (
              <div className="bg-blue-50 p-4 rounded-lg">
                <div className="flex items-center justify-between">
                  <div className="flex items-center">
                    <FileText className="h-8 w-8 text-blue-600 mr-3 shrink-0" />
                    <div>
                      <p className="font-medium text-gray-900">{selectedFile.name}</p>
                      <p className="text-sm text-gray-500">{(selectedFile.size / 1024 / 1024).toFixed(2)} MB</p>
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFile();
                    }}
                    disabled={isTranslating}
                    className="text-red-600 hover:text-red-800 p-2 disabled:opacity-50"
                  >
                    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                  </button>
                </div>
              </div>
            )}

            {isTranslating && (
              <div className="space-y-2">
                <div className="flex justify-between text-sm text-gray-600">
                  <span>Translating your document...</span>
                  <span>{progress}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                    style={{ width: `${progress}%` }}
                  ></div>
                </div>
              </div>
            )}

            {error && (
              <div className="bg-red-50 p-4 rounded-lg text-red-700 text-sm border border-red-200">
                <div className="flex items-start">
                  <svg className="h-5 w-5 text-red-400 mt-0.5 mr-2" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                  </svg>
                  <span>{error}</span>
                </div>
              </div>
            )}

            {/* Target language picker */}
            <div>
              <label htmlFor="target-lang" className="block text-sm font-medium text-gray-700 mb-2">
                <Globe className="inline h-4 w-4 mr-1 text-blue-600" />
                Translate to
              </label>
              <select
                id="target-lang"
                value={targetLang}
                onChange={(e) => setTargetLang(e.target.value)}
                disabled={isTranslating}
                className="w-full sm:w-72 px-4 py-2.5 border border-gray-300 rounded-md bg-white text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
              >
                {TARGET_LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col sm:flex-row gap-4">
              <button
                onClick={handleTranslate}
                disabled={!selectedFile || isTranslating}
                className={`flex-1 px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-gradient-to-r from-blue-600 to-indigo-700 hover:from-blue-700 hover:to-indigo-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-all ${
                  !selectedFile || isTranslating ? 'opacity-50 cursor-not-allowed' : ''
                }`}
              >
                {isTranslating ? (
                  <>
                    <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white inline" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Translating...
                  </>
                ) : (
                  `Translate to ${targetLabel}`
                )}
              </button>
            </div>
          </div>
        </div>

        {translatedFile && (
          <div className="bg-green-50 rounded-xl shadow-lg overflow-hidden p-8 mb-8 border border-green-200">
            <div className="flex items-center mb-4">
              <svg className="h-6 w-6 text-green-500 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path>
              </svg>
              <h2 className="text-xl font-semibold text-green-800">Translation Complete!</h2>
            </div>

            <div className="bg-white p-4 rounded-lg flex items-center justify-between mb-6">
              <div className="flex items-center">
                <FileText className="h-8 w-8 text-blue-600 mr-3 shrink-0" />
                <div>
                  <p className="font-medium text-gray-900">Translated Document</p>
                  <p className="text-sm text-gray-500">PDF translated to {targetLabel}</p>
                </div>
              </div>

              <a
                href={translatedFile}
                download={selectedFile ?
                  `${selectedFile.name.replace('.pdf', '')}_translated_${targetLang}.pdf` :
                  'translated_document.pdf'
                }
                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-200 transition-colors"
              >
                Download PDF
              </a>
            </div>

            <button
              onClick={removeFile}
              className="w-full px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500"
            >
              Translate Another Document
            </button>
          </div>
        )}

        <div className="bg-white rounded-xl shadow-lg overflow-hidden p-8">
          <h2 className="text-xl text-black font-semibold mb-4">How It Works</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="text-center">
              <div className="mx-auto bg-blue-100 w-16 h-16 rounded-full flex items-center justify-center mb-4">
                <span className="text-2xl font-bold text-blue-600">1</span>
              </div>
              <h3 className="font-medium text-gray-900 mb-2">Upload PDF</h3>
              <p className="text-gray-600 text-sm">Upload a PDF document in any language</p>
            </div>
            <div className="text-center">
              <div className="mx-auto bg-blue-100 w-16 h-16 rounded-full flex items-center justify-center mb-4">
                <span className="text-2xl font-bold text-blue-600">2</span>
              </div>
              <h3 className="font-medium text-gray-900 mb-2">AI Translation</h3>
              <p className="text-gray-600 text-sm">Our AI translates text while preserving mathematical formulas and diagrams</p>
            </div>
            <div className="text-center">
              <div className="mx-auto bg-blue-100 w-16 h-16 rounded-full flex items-center justify-center mb-4">
                <span className="text-2xl font-bold text-blue-600">3</span>
              </div>
              <h3 className="font-medium text-gray-900 mb-2">Download</h3>
              <p className="text-gray-600 text-sm">Get your translated PDF in the language you chose</p>
            </div>
          </div>

          <div className="mt-8 p-4 bg-blue-50 rounded-lg space-y-4">
            <div>
              <h3 className="font-medium text-gray-900 mb-2">Supported Languages</h3>
              <p className="text-gray-600 text-sm">Translate from any language into 30 target languages including English, Spanish, French, German, Italian, Portuguese, Chinese, Japanese, Korean, Arabic, Russian, and more. The source language is detected automatically.</p>
            </div>
            <div>
              <h3 className="font-medium text-gray-900 mb-2">Formula & Diagram Preservation</h3>
              <p className="text-gray-600 text-sm">The translated PDF includes both the translated text and the original pages with all mathematical formulas, diagrams, and images preserved perfectly.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
