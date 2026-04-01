---
name: code-review
description: Reviews code for quality, security, and best practices.
license: MIT
compatibility: Claude 3.5+, GPT-4+
metadata:
  author: koi-team
  category: development
allowed-tools: read_file write_file search
---

# Code Review Skill

This skill enables an agent to perform comprehensive code reviews.

## Usage

Attach this skill to any agent that needs code review capabilities.

```javascript
const result = await reviewCode(files);
```

## Guidelines

- Focus on correctness first
- Check for security vulnerabilities
- Suggest performance improvements
