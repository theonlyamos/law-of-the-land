"use client";

import { Button } from "@/components/ui/button";
import { ChatInput } from "@/components/ui/chat-input";
import { Check } from "lucide-react";
import Image from 'next/image';
import logo from '@/app/logo-transparent.png';

const SUGGESTED_QUESTIONS = [
  "What are my rights as a tenant?",
  "Can I get a refund for a defective product?",
  "What should I do if I get a speeding ticket?",
  "What are the rules for returning items to stores?",
  "What are my rights at work?"
];

interface LandingPageProps {
  query: string;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  isLoading: boolean;
}

export function LandingPage({ query, onQueryChange, onSearch, onKeyDown, isLoading }: LandingPageProps) {
  const handleSuggestedQuestion = (question: string) => {
    onQueryChange(question);
    onSearch();
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-4">
      {/* Logo */}
      <Image
        src={logo}
        alt="Law of the Land Logo"
        width={120}
        className="md:w-40 mb-8"
        priority
      />
      
      {/* Writings in the middle */}
      <div className="text-center max-w-2xl mb-8">
        <h1 className="text-3xl md:text-4xl font-bold mb-4">
          Get Clear Answers to Legal Questions
        </h1>
        <p className="text-lg text-muted-foreground mb-6">
          Law of the Land transforms complex laws and regulations into clear, understandable answers. 
          Ask a question about your rights or local laws to get started.
        </p>
        
        {/* Feature bullets */}
        <div className="flex flex-wrap justify-center gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <Check className="h-4 w-4 text-primary" />
            <span>AI-powered legal research</span>
          </div>
          <div className="flex items-center gap-2">
            <Check className="h-4 w-4 text-primary" />
            <span>Plain language answers</span>
          </div>
          <div className="flex items-center gap-2">
            <Check className="h-4 w-4 text-primary" />
            <span>Up-to-date legal information</span>
          </div>
        </div>
      </div>
      
      {/* Textarea in the middle */}
      <div className="w-full max-w-2xl">
        <ChatInput 
          query={query}
          onQueryChange={onQueryChange}
          onSearch={onSearch}
          onKeyDown={onKeyDown}
          isLoading={isLoading}
          rows={3}
          placeholder="Type your legal question here..."
        />
      </div>
      
      {/* Suggested questions below */}
      <div className="w-full max-w-2xl mt-8">
        <p className="text-sm text-muted-foreground mb-3 text-center">Or try one of these:</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {SUGGESTED_QUESTIONS.map((question, index) => (
            <Button
              key={index}
              variant="outline"
              className="justify-start text-left h-auto py-2 px-4 text-sm md:text-base"
              onClick={() => handleSuggestedQuestion(question)}
            >
              {question}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
